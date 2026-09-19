import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.ts';
import { createServer } from '../src/admin/server.ts';
import { rankRound } from '../src/queue/ranking.ts';
import { listMessages, pendingMessages } from '../src/sms/dispatch.ts';
import { awardedTotal, getCase, isRoundOpen, listRefusedActions } from '../src/store/cases.ts';
import { seedDatabase } from '../src/seed/data.ts';

const OPEN_ROUND = 'R-2026-T2';

interface Form {
  action: string;
  fields: Record<string, string>;
}

/** Every <form> on a page, with its action and the values of its hidden and pre-filled inputs. */
function formsOn(html: string): Form[] {
  return [...html.matchAll(/<form[^>]*method="post"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => {
    const fields: Record<string, string> = {};
    for (const input of m[2].matchAll(/<input([^>]*)>/g)) {
      const name = /name="([^"]+)"/.exec(input[1])?.[1];
      const value = /value="([^"]*)"/.exec(input[1])?.[1];
      if (name) fields[name] = value?.replace(/&amp;/g, '&') ?? '';
    }
    return { action: m[1], fields };
  });
}

async function serve(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-admin-'));
  const path = join(dir, 'zamu.db');
  seedDatabase(path);
  const db = openDatabase(path);
  const server = createServer(db);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const base = `http://127.0.0.1:${port}`;
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { headers });
    return { status: res.status, body: await res.text() };
  };
  const raw = async (path: string, body: string, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method: 'POST',
      body,
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    const location = res.headers.get('location') ?? '';
    const query = new URL(location || '/', base).searchParams;
    return { status: res.status, location, kind: query.get('kind'), notice: query.get('notice') ?? '', body: await res.text() };
  };
  /**
   * Submits the dashboard's own form, exactly as a browser would: the action and hidden fields
   * come from the rendered page; only the visible inputs are filled in.
   */
  const submit = async (page: string, actionEndsWith: string, visible: Record<string, string> = {}) => {
    const html = (await get(page)).body;
    const form = formsOn(html).find((f) => f.action.endsWith(actionEndsWith));
    assert.ok(form, `no form ending ${actionEndsWith} on ${page}`);
    return raw(form.action, new URLSearchParams({ ...form.fields, ...visible }).toString());
  };
  const token = formsOn((await get('/?as=CLERK-01')).body)[0].fields.token;
  return { db, get, raw, submit, token, base, port };
}

const round = (as: string) => `/round/${OPEN_ROUND}?as=${as}`;

test('a whole round runs through the dashboard’s own forms: create, open, decide, pay, confirm, close', async (t) => {
  const { db, submit } = await serve(t);

  const created = await submit('/?as=CLERK-01', '/rounds', { name: '2026 Term 3', budget: '90000' });
  assert.equal(created.kind, 'ok', created.notice);
  const opened = await submit('/?as=CLERK-01', '/round/R-2026-TERM-3/open');
  assert.equal(opened.kind, 'ok', opened.notice);
  assert.ok(isRoundOpen(db, 'R-2026-TERM-3'));

  // The rest of the flow on the seeded open round, where there are applications to decide.
  const verified = rankRound(db, OPEN_ROUND).filter((e) => e.stage === 'verified').slice(0, 2);
  const applied = rankRound(db, OPEN_ROUND).filter((e) => e.stage === 'applied');
  assert.equal((await submit(round('CHV-01'), `/case/${applied[0].caseId}/verify`)).kind, 'ok');
  const rejected = await submit(round('BC-01'), `/case/${applied[1].caseId}/reject`, { note: 'evidence did not match the visit' });
  assert.equal(rejected.kind, 'ok', rejected.notice);
  assert.equal(getCase(db, applied[1].caseId).currentStage, 'rejected');

  for (const entry of verified) {
    const school = (db.prepare('SELECT school_id FROM children WHERE id = ?').get(entry.childId) as { school_id: string }).school_id;
    assert.equal((await submit(round('BC-01'), `/case/${entry.caseId}/award`, { amount: '12000' })).kind, 'ok');
    assert.equal((await submit(round('CLERK-01'), `/case/${entry.caseId}/pay`)).kind, 'ok');
    assert.equal((await submit(round(school), `/case/${entry.caseId}/confirm`)).kind, 'ok');
    assert.equal(getCase(db, entry.caseId).currentStage, 'school_confirmed');
  }
  assert.equal((await submit('/?as=CLERK-01', `/round/${OPEN_ROUND}/close`)).kind, 'ok');
  const sms = await submit('/?as=CLERK-01', '/sms');
  assert.match(sms.notice, /Queued \d+ SMS/);

  assert.equal(isRoundOpen(db, OPEN_ROUND), false);
  assert.equal(awardedTotal(db, OPEN_ROUND), 24_000);
  const messages = listMessages(db);
  for (const entry of verified) assert.ok(messages.some((m) => m.caseId === entry.caseId && m.template === 'smsSchoolConfirmed'));
  const rejection = messages.find((m) => m.caseId === applied[1].caseId && m.template === 'smsRejected');
  assert.ok(rejection?.body.includes('evidence did not match the visit'), 'the reason reaches the parent');
  assert.ok(pendingMessages(db).length > 0, 'the dashboard only queues; it never marks messages sent');
  assert.equal(listRefusedActions(db).length, 0, 'every step was done by its own role');
});

test('the rendered forms carry the fields the server reads', async (t) => {
  const { get } = await serve(t);
  const html = (await get(round('BC-01'))).body;
  const forms = formsOn(html);
  assert.ok(forms.length > 0);
  for (const form of forms) {
    assert.equal(form.fields.as, 'BC-01', `${form.action} is missing who is acting`);
    assert.ok(form.fields.token, `${form.action} is missing the token`);
  }
  assert.match(html, /name="note"/);
  assert.match(html, /name="amount"/);
});

test('a refused action comes back as a banner, and is logged', async (t) => {
  const { db, get, submit } = await serve(t);
  const applied = rankRound(db, OPEN_ROUND).find((e) => e.stage === 'applied')!;
  const refused = await submit(round('CLERK-01'), `/case/${applied.caseId}/verify`);
  assert.equal(refused.status, 303);
  assert.equal(refused.kind, 'refused');
  assert.match(refused.notice, /may not verify a case/);
  const page = await get(refused.location.replace(/^https?:\/\/[^/]+/, ''));
  assert.match(page.body, /class="banner refused"/);
  assert.doesNotMatch(page.body, /at handle|\.ts:\d+|SQLITE/);
  assert.equal(getCase(db, applied.caseId).currentStage, 'applied');
  assert.equal(listRefusedActions(db)[0].actorId, 'CLERK-01');
  assert.match((await get('/refused?as=CLERK-01')).body, /only a community health volunteer or teacher may do this/);
});

test('a blank or long reason, an over-budget award, a bad amount, and the wrong school are refused', async (t) => {
  const { db, submit } = await serve(t);
  const [first, second] = rankRound(db, OPEN_ROUND).filter((e) => e.stage === 'verified');
  assert.match((await submit(round('BC-01'), `/case/${first.caseId}/reject`, { note: '' })).notice, /needs a written reason/);
  assert.match((await submit(round('BC-01'), `/case/${first.caseId}/reject`, { note: 'x'.repeat(51) })).notice, /at most 50/);
  assert.match((await submit(round('BC-01'), `/case/${first.caseId}/award`, { amount: '999999' })).notice, /budget/);
  for (const amount of ['1e4', '0x2EE0', ' 12 000', '-5']) {
    assert.equal((await submit(round('BC-01'), `/case/${first.caseId}/award`, { amount })).kind, 'refused', amount);
  }
  await submit(round('BC-01'), `/case/${second.caseId}/award`, { amount: '1000' });
  await submit(round('CLERK-01'), `/case/${second.caseId}/pay`);
  const school = (db.prepare('SELECT school_id FROM children WHERE id = ?').get(second.childId) as { school_id: string }).school_id;
  const other = ['SCH-1', 'SCH-2', 'SCH-3'].find((s) => s !== school)!;
  const wrong = await submit(round(other), `/case/${second.caseId}/confirm`);
  assert.equal(wrong.kind, 'refused');
  assert.match(wrong.notice, /registered at/);
});

test('only the clerk may queue the SMS, and the refusal is logged', async (t) => {
  const { db, submit } = await serve(t);
  const refused = await submit('/?as=TCH-01', '/sms');
  assert.equal(refused.kind, 'refused');
  assert.equal(listRefusedActions(db)[0].attempted, 'dispatch_sms');
});

test('the acting person must be on the staff list; the form cannot claim a role', async (t) => {
  const { db, raw, token } = await serve(t);
  const applied = rankRound(db, OPEN_ROUND).find((e) => e.stage === 'applied')!;
  assert.equal((await raw(`/case/${applied.caseId}/verify`, `token=${token}&as=NOBODY`)).status, 400);
  assert.equal(listRefusedActions(db)[0].actorId, 'NOBODY', 'a forged identity is on the record too');
  assert.equal((await raw(`/case/${applied.caseId}/verify`, `token=${token}`)).status, 400);
  const forged = await raw(`/case/${applied.caseId}/verify`, `token=${token}&as=CLERK-01&role=chv`);
  assert.equal(forged.kind, 'refused');
});

test('a page on another site cannot drive the dashboard', async (t) => {
  const { db, raw, token } = await serve(t);
  const applied = rankRound(db, OPEN_ROUND).find((e) => e.stage === 'applied')!;
  const path = `/case/${applied.caseId}/verify`;
  assert.equal((await raw(path, 'as=CHV-01')).status, 403, 'no token');
  assert.equal((await raw(path, `token=wrong&as=CHV-01`)).status, 403, 'wrong token');
  assert.equal((await raw(path, `token=${token}&as=CHV-01`, { origin: 'https://evil.example' })).status, 403, 'foreign origin');
  assert.equal((await raw(path, `token=${token}&as=CHV-01`, { 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site fetch');
  assert.equal((await raw(path, `token=${token}&as=CHV-01`, { 'content-type': 'text/plain' })).status, 415, 'not a form post');
  assert.equal(getCase(db, applied.caseId).currentStage, 'applied', 'none of those did anything');
});

test('a real browser submitting the dashboard’s own form is accepted', async (t) => {
  const { db, raw, token, port } = await serve(t);
  const applied = rankRound(db, OPEN_ROUND).find((e) => e.stage === 'applied')!;
  // What Chrome sends for a same-origin form post under the dashboard's referrer policy.
  const res = await raw(`/case/${applied.caseId}/verify`, `token=${token}&as=CHV-01`, {
    origin: `http://127.0.0.1:${port}`,
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(res.kind, 'ok', `${res.status} ${res.body.slice(0, 200)}`);
  // `Origin: null` is what a no-referrer policy would have produced: it must never be needed.
  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.headers.get('referrer-policy'), 'same-origin');
});

test('a rebound hostname cannot read the dashboard', async (t) => {
  const { port } = await serve(t);
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { host: `rebind.evil.example:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
});

test('a forged success banner is not shown', async (t) => {
  const { get } = await serve(t);
  const page = await get('/?as=BC-01&kind=ok&notice=ZM-0001+awarded+50000.');
  assert.doesNotMatch(page.body, /class="banner ok"/);
  assert.doesNotMatch(page.body, /awarded 50000/);
});

test('every page names who is acting, and pages render for each view', async (t) => {
  const { get } = await serve(t);
  const home = await get('/?as=BC-01');
  assert.equal(home.status, 200);
  assert.match(home.body, /Acting as <strong>Bursary Committee, Mwangaza Ward<\/strong> · Bursary committee/);
  assert.match(home.body, /Close round/);
  assert.match((await get(round('CHV-01'))).body, /Acting as <strong>Ruth Nekesa<\/strong>/);
  assert.match((await get('/')).body, /Choose who you are/);
  assert.equal((await get('/round/NOPE')).status, 404);
  assert.equal((await get('/nothing')).status, 404);
  assert.equal((await get('/round/%E0%A4%A')).status, 404);
});

test('unknown cases, rounds and actions are 404s', async (t) => {
  const { raw, token } = await serve(t);
  assert.equal((await raw('/case/ZM-9999/verify', `token=${token}&as=CHV-01`)).status, 404);
  assert.equal((await raw('/round/NOPE/open', `token=${token}&as=CLERK-01`)).status, 404);
  assert.equal((await raw('/case/ZM-0001/delete', `token=${token}&as=CLERK-01`)).status, 404);
});

/** Starts the real entry point and returns the address it reports having bound to. */
async function launch(t: { after: (fn: () => void) => void }, env: Record<string, string>): Promise<{ out: string; code: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-admin-bind-'));
  const path = join(dir, 'zamu.db');
  seedDatabase(path);
  const child = spawn(process.execPath, ['src/admin/run.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, ZAMU_DB: path, ADMIN_PORT: String(40_000 + Math.floor(Math.random() * 10_000)), ...env },
  });
  t.after(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no output: ${out}`)), 10_000);
    const done = (code: number | null) => {
      clearTimeout(timer);
      resolve({ out, code });
    };
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) done(null);
    });
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('exit', (code) => done(code));
  });
}

test('the dashboard binds to localhost, reporting the address it really bound', async (t) => {
  const { out } = await launch(t, { ADMIN_HOST: '' });
  // The banner is built from server.address(), so it proves where the socket is, not what was asked.
  assert.match(out, /on http:\/\/127\.0\.0\.1:\d+/);
});

test('the dashboard refuses to serve on a network address', async (t) => {
  const { out, code } = await launch(t, { ADMIN_HOST: '0.0.0.0' });
  assert.equal(code, 1);
  assert.match(out, /Refusing to serve the staff dashboard on 0\.0\.0\.0/);
});

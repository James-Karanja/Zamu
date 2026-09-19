import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, openReadOnly } from '../src/db/connection.ts';
import { createServer } from '../src/web/server.ts';
import { escapeHtml, renderIndex, renderRound } from '../src/web/render.ts';
import { seedDatabase } from '../src/seed/data.ts';
import { rankRound, type PublicQueueEntry, type RoundSummary } from '../src/queue/ranking.ts';
import { createRound, openRound } from '../src/store/cases.ts';
import { CLERK, registerStaff, tempDir } from './helpers.ts';
import { addSchool } from '../src/store/registry.ts';

const OPEN_ROUND = 'R-2026-T2';

/** A server on an ephemeral port backed by the given database. */
async function serveDb(t: Parameters<typeof tempDir>[0], db: DatabaseSync, dir: string) {
  const server = createServer(db);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const get = async (path: string, init?: RequestInit, withHeaders = false) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      headers: withHeaders ? res.headers : undefined,
      body: await res.text(),
    };
  };
  return { db, get };
}

/** A server backed by a freshly seeded database, served read-only as in production. */
async function serve(t: Parameters<typeof tempDir>[0]) {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-web-'));
  const path = join(dir, 'zamu.db');
  seedDatabase(path);
  return serveDb(t, openReadOnly(path), dir);
}

/** A server backed by a database holding one open round and no applications. */
async function serveEmpty(t: Parameters<typeof tempDir>[0]) {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-web-empty-'));
  const db = openDatabase(join(dir, 'zamu.db'));
  addSchool(db, { id: 'SCH-T', name: 'Test School', county: 'Test County', ward: 'Test Ward' });
  registerStaff(db);
  createRound(db, { id: 'R-T', name: 'Empty Round', ward: 'Test Ward', currency: 'KES', budget: 10_000 }, CLERK);
  openRound(db, 'R-T', CLERK);
  return serveDb(t, db, dir);
}

test('the index lists every round, newest first', async (t) => {
  const { get } = await serve(t);
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/html/);
  assert.ok(res.body.indexOf('2026 Term 2') < res.body.indexOf('2025 Term 3'), 'newest round first');
  assert.match(res.body, /href="\/round\/R-2026-T2"/);
});

test('a round page shows the ranked queue and the round money', async (t) => {
  const { db, get } = await serve(t);
  const res = await get(`/round/${OPEN_ROUND}`);
  assert.equal(res.status, 200);
  const entries = rankRound(db, OPEN_ROUND);
  assert.match(res.body, /Budget/);
  assert.match(res.body, /KES 180,000/);
  for (const entry of entries.slice(0, 3)) {
    assert.ok(res.body.includes(entry.caseId), `${entry.caseId} missing`);
    assert.ok(res.body.includes(escapeHtml(entry.maskedName)), `${entry.maskedName} missing`);
  }
  const firstPosition = res.body.indexOf(entries[0].caseId);
  const secondPosition = res.body.indexOf(entries[1].caseId);
  assert.ok(firstPosition < secondPosition, 'queue order follows ranking');
});

test('a full queue page stays small enough for a weak connection', async (t) => {
  const { get } = await serve(t);
  const res = await get(`/round/${OPEN_ROUND}`);
  assert.ok(Buffer.byteLength(res.body) < 50_000, `page is ${Buffer.byteLength(res.body)} bytes`);
  assert.ok(!/<script/i.test(res.body), 'no client JavaScript');
  assert.ok(!/https?:\/\/(?!localhost|127\.0\.0\.1)/.test(res.body), 'no external requests');
});

test('the JSON view publishes the same entries', async (t) => {
  const { db, get } = await serve(t);
  const res = await get(`/round/${OPEN_ROUND}.json`);
  assert.equal(res.status, 200);
  assert.match(res.type, /application\/json/);
  const data = JSON.parse(res.body) as { round: { id: string }; queue: { caseId: string; position: number }[] };
  assert.equal(data.round.id, OPEN_ROUND);
  assert.deepEqual(data.queue.map((e) => e.caseId), rankRound(db, OPEN_ROUND).map((e) => e.caseId));
});

test('no response leaks household detail', async (t) => {
  const { db, get } = await serve(t);
  const rounds = ['R-2026-T2', 'R-2026-T1', 'R-2025-T3'];
  const responses = [(await get('/')).body];
  for (const roundId of rounds) {
    responses.push((await get(`/round/${roundId}`)).body, (await get(`/round/${roundId}.json`)).body);
  }
  const bodies = responses.join('\n');

  const secrets = db
    .prepare(
      `SELECT h.phone AS phone, c.name AS child_name, h.guardian_name AS guardian, e.photo_ref AS photo,
              e.lat AS lat, e.lng AS lng, e.fee_balance AS fee, e.house_type AS house_type,
              e.land_acres AS land_acres
       FROM cases cs JOIN children c ON c.id = cs.child_id JOIN households h ON h.id = c.household_id
       JOIN evidence e ON e.case_id = cs.id`,
    )
    .all() as unknown as {
      phone: string; child_name: string; guardian: string; photo: string;
      lat: number; lng: number; fee: number; house_type: string; land_acres: number;
    }[];

  for (const row of secrets) {
    assert.ok(!bodies.includes(row.phone), `phone ${row.phone} leaked`);
    assert.ok(!bodies.includes(row.child_name), `child name ${row.child_name} leaked`);
    assert.ok(!bodies.includes(row.guardian), `guardian ${row.guardian} leaked`);
    assert.ok(!bodies.includes(row.photo), `photo ref ${row.photo} leaked`);
    assert.ok(!bodies.includes(String(row.lat)), `latitude ${row.lat} leaked`);
    assert.ok(!bodies.includes(String(row.lng)), `longitude ${row.lng} leaked`);
    if (row.fee > 0) {
      const formatted = String(row.fee).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      for (const needle of [String(row.fee), formatted]) {
        const standalone = new RegExp(`(?<![\\d,])${needle.replace(/,/g, ',')}(?![\\d,])`);
        assert.ok(!standalone.test(bodies), `fee balance ${needle} leaked`);
      }
    }
    assert.ok(!bodies.includes(row.house_type), `house type ${row.house_type} leaked`);
    assert.ok(!bodies.includes(`${row.land_acres} acre`), `land ${row.land_acres} leaked`);
  }
});

test('unknown rounds and paths give a plain 404', async (t) => {
  const { get } = await serve(t);
  for (const path of ['/round/NOPE', '/round/NOPE.json', '/anything', '/round/']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.ok(!/RoundNotFoundError|SQLITE|at Object|\.ts:\d+/.test(res.body), `${path} leaked internals`);
  }
});

test('the server refuses methods that would imply a change', async (t) => {
  const { get } = await serve(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await get('/', { method })).status, 405, method);
  }
});

test('an empty round renders its empty-queue note, and an empty index says so', async (t) => {
  const { get } = await serveEmpty(t);
  const round = await get('/round/R-T');
  assert.equal(round.status, 200);
  assert.match(round.body, /No applications in this round yet/);
  assert.match(round.body, /Applicants/);
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.body, /Empty Round/);
});

test('a malformed address is a 404, not a server error', async (t) => {
  const { get } = await serve(t);
  for (const path of ['/round/%E0%A4%A', '/%', '/round/%zz.json']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.ok(!/URIError|at handle|\.ts:\d+/.test(res.body), `${path} leaked internals`);
  }
});

test('JSON routes answer errors as JSON', async (t) => {
  const { get } = await serve(t);
  const res = await get('/round/NOPE.json');
  assert.equal(res.status, 404);
  assert.match(res.type, /application\/json/);
  assert.deepEqual(JSON.parse(res.body), { error: 'That round does not exist.' });
});

test('a failing database gives a plain 500, never internals', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-web-broken-'));
  const path = join(dir, 'zamu.db');
  seedDatabase(path);
  const db = openReadOnly(path);
  const { get } = await serveDb(t, db, dir);
  db.close(); // every query now throws
  const res = await get('/');
  assert.equal(res.status, 500);
  assert.ok(!/SQLITE|database is closed|at handle|\.ts:\d+/.test(res.body), 'leaked internals');
  assert.match(res.body, /Something went wrong/);
});

test('responses carry the headers that keep the page inert and cheap', async (t) => {
  const { get } = await serve(t);
  const res = await get(`/round/${OPEN_ROUND}`, undefined, true);
  assert.match(res.headers?.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(res.headers?.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers?.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers?.get('cache-control') ?? '', /max-age/);
  const denied = await get('/', { method: 'POST' }, true);
  assert.equal(denied.status, 405);
  assert.equal(denied.headers?.get('allow'), 'GET, HEAD');
  assert.equal((await get('/favicon.ico')).status, 204);
});

test('the server never writes to the database it publishes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-web-ro-'));
  const path = join(dir, 'zamu.db');
  seedDatabase(path);
  const before = readFileSync(path);
  const { get } = await serveDb(t, openReadOnly(path), dir);
  await get('/');
  await get(`/round/${OPEN_ROUND}`);
  await get(`/round/${OPEN_ROUND}.json`);
  assert.ok(before.equals(readFileSync(path)), 'database file changed while serving');
});

test('rendered pages escape values that carry markup', () => {
  const summary: RoundSummary = {
    id: 'R-X', name: `Term <b>"one"</b> & 'two'`, ward: "St. Mary's <ward>", currency: 'KES',
    budget: 1000, awarded: 0, recipients: 0, applicants: 1, status: 'open',
  };
  const entry: PublicQueueEntry = {
    position: 1, caseId: 'ZM-0001', maskedName: `A. <script>`, school: `St. Mary's & Sons <b>`,
    need: 10, waitingBonus: 0, priority: 10, stage: 'applied', awardAmount: null,
  };
  const html = renderRound(summary, [entry]);
  assert.ok(!html.includes('<script>'), 'raw markup rendered');
  assert.ok(!html.includes("St. Mary's & Sons <b>"), 'raw school rendered');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /St. Mary&#39;s &amp; Sons &lt;b&gt;/);
  assert.match(renderIndex([summary]), /Term &lt;b&gt;&quot;one&quot;&lt;\/b&gt; &amp; &#39;two&#39;/);
});

test('escaping keeps injected markup inert', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

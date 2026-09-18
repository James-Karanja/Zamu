import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.ts';
import { createServer } from '../src/ussd/server.ts';
import { MAX_SCREEN } from '../src/ussd/session.ts';
import { listCurrentCases } from '../src/store/cases.ts';
import { OPEN_ROUND_SKIPPED, seedDatabase } from '../src/seed/data.ts';
import { tempDir } from './helpers.ts';

const DEMO_CHILD = `CH-${String(OPEN_ROUND_SKIPPED[0] + 1).padStart(3, '0')}`;

/** The gateway posts `sessionId`, `serviceCode`, `phoneNumber` and `text` as a form body. */
async function serve(t: Parameters<typeof tempDir>[0]) {
  const dir = mkdtempSync(join(tmpdir(), 'zamu-ussd-'));
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

  const dial = async (phoneNumber: string, text: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/ussd`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sessionId: 'ATUid_test', serviceCode: '*384*1234#', phoneNumber, text }),
    });
    return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
  };
  return { db, port, dial };
}

test('the gateway gets a CON menu on an empty text', async (t) => {
  const { dial } = await serve(t);
  const res = await dial('+254700000001', '');
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/plain/);
  assert.ok(res.body.startsWith('CON '), res.body);
  assert.ok(res.body.length <= MAX_SCREEN);
});

test('a full apply session over HTTP creates the case', async (t) => {
  const { db, dial } = await serve(t);
  const row = db
    .prepare('SELECT h.phone AS phone FROM children c JOIN households h ON h.id = c.household_id WHERE c.id = ?')
    .get(DEMO_CHILD) as { phone: string };
  const children = db
    .prepare('SELECT c.id AS id FROM children c JOIN households h ON h.id = c.household_id WHERE h.phone = ? ORDER BY c.id')
    .all(row.phone) as unknown as { id: string }[];
  const index = String(children.findIndex((c) => c.id === DEMO_CHILD) + 1);

  assert.ok((await dial(row.phone, '1')).body.startsWith('CON '));
  assert.ok((await dial(row.phone, `1*${index}`)).body.startsWith('CON '));
  const done = await dial(row.phone, `1*${index}*1`);
  assert.ok(done.body.startsWith('END '), done.body);
  assert.ok(listCurrentCases(db, 'R-2026-T2').some((c) => c.childId === DEMO_CHILD));
});

test('every reply is plain text within the screen limit', async (t) => {
  const { dial } = await serve(t);
  for (const text of ['', '1', '2', '3', '4', '9', '1*1', '1*99']) {
    const res = await dial('+254700000001', text);
    assert.match(res.type, /text\/plain/);
    assert.ok(/^(CON|END) /.test(res.body), `${text}: ${res.body}`);
    assert.ok(res.body.length <= MAX_SCREEN, `${text}: ${res.body.length} chars`);
  }
});

test('an unknown number ends the session politely', async (t) => {
  const { dial } = await serve(t);
  const res = await dial('+254700000999', '');
  assert.ok(res.body.startsWith('END '));
  assert.match(res.body, /not registered/i);
});

test('a missing phone number does not crash the gateway', async (t) => {
  const { port } = await serve(t);
  const res = await fetch(`http://127.0.0.1:${port}/ussd`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'sessionId=x&serviceCode=*384#',
  });
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(body.startsWith('END '), body);
});

test('a body that is not form data still gets a USSD reply', async (t) => {
  const { port } = await serve(t);
  const res = await fetch(`http://127.0.0.1:${port}/ussd`, { method: 'POST', body: '{"not":"a form"}' });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).startsWith('END '));
});

test('a wrong method on the USSD path answers 405 with Allow', async (t) => {
  const { port } = await serve(t);
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const res = await fetch(`http://127.0.0.1:${port}/ussd`, { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'POST');
  }
});

test('an unknown path answers 404, not 405', async (t) => {
  const { port } = await serve(t);
  for (const path of ['/', '/other']) {
    const res = await fetch(`http://127.0.0.1:${path === '/' ? `${port}/` : `${port}${path}`}`, { method: 'POST' });
    assert.equal(res.status, 404, path);
  }
});

test('an oversized body is refused', async (t) => {
  const { port } = await serve(t);
  const res = await fetch(`http://127.0.0.1:${port}/ussd`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `phoneNumber=%2B254700000001&text=${'9'.repeat(20_000)}`,
  });
  assert.equal(res.status, 413);
});

test('a failing database still returns a valid USSD reply', async (t) => {
  const { db, dial } = await serve(t);
  db.close();
  const res = await dial('+254700000001', '');
  assert.equal(res.status, 200);
  assert.ok(res.body.startsWith('END '), res.body);
  assert.ok(!/SQLITE|\.ts:\d+|at /.test(res.body), res.body);
});

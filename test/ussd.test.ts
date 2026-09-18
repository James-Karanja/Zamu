import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/connection.ts';
import { MAX_SCREEN, isStale, renderReply, respond, type UssdReply } from '../src/ussd/session.ts';
import { listCurrentCases, listVerificationRequests } from '../src/store/cases.ts';
import { scoreNeed } from '../src/scoring/model.ts';
import { rankRound } from '../src/queue/ranking.ts';
import { OPEN_ROUND_SKIPPED, seedDatabase } from '../src/seed/data.ts';
import { tempDir } from './helpers.ts';

const OPEN_ROUND = 'R-2026-T2';
/** CH-035 applied in an earlier round, so it has evidence on file and no open-round case. */
const DEMO_CHILD_INDEX = OPEN_ROUND_SKIPPED[0];
const DEMO_CHILD = `CH-${String(DEMO_CHILD_INDEX + 1).padStart(3, '0')}`;

function seeded(t: Parameters<typeof tempDir>[0]) {
  const path = join(tempDir(t), 'zamu.db');
  seedDatabase(path);
  const db = openDatabase(path);
  t.after(() => db.close());
  return db;
}

function phoneOf(db: ReturnType<typeof seeded>, childId: string): string {
  const row = db
    .prepare('SELECT h.phone AS phone FROM children c JOIN households h ON h.id = c.household_id WHERE c.id = ?')
    .get(childId) as { phone: string };
  return row.phone;
}

function childIndexFor(db: ReturnType<typeof seeded>, phone: string, childId: string): string {
  const rows = db
    .prepare('SELECT c.id AS id FROM children c JOIN households h ON h.id = c.household_id WHERE h.phone = ? ORDER BY c.id')
    .all(phone) as unknown as { id: string }[];
  return String(rows.findIndex((r) => r.id === childId) + 1);
}

/** Runs a session keypress by keypress, checking every screen along the way. */
function dial(db: ReturnType<typeof seeded>, phone: string, keys: string[]): UssdReply {
  let reply = respond(db, { phoneNumber: phone, text: '' });
  checkScreen(reply);
  for (let i = 0; i < keys.length; i++) {
    reply = respond(db, { phoneNumber: phone, text: keys.slice(0, i + 1).join('*') });
    checkScreen(reply);
  }
  return reply;
}

function checkScreen(reply: UssdReply): void {
  const wire = renderReply(reply);
  assert.ok(wire.startsWith('CON ') || wire.startsWith('END '), `bad prefix: ${wire}`);
  assert.ok(wire.length <= MAX_SCREEN, `screen too long (${wire.length}): ${wire}`);
}

test('an unregistered number is told where to register', (t) => {
  const db = seeded(t);
  const reply = respond(db, { phoneNumber: '+254700000777', text: '' });
  assert.equal(reply.type, 'END');
  assert.match(reply.text, /not registered/i);
  checkScreen(reply);
});

test('the first screen offers the four choices in the household language', (t) => {
  const db = seeded(t);
  const english = respond(db, { phoneNumber: '+254700000001', text: '' });
  assert.equal(english.type, 'CON');
  assert.match(english.text, /1\. Apply[\s\S]*2\. My place[\s\S]*3\. My score[\s\S]*4\. Add a child/);

  const swahili = respond(db, { phoneNumber: '+254700000002', text: '' });
  assert.match(swahili.text, /1\. Omba[\s\S]*2\. Nafasi yangu[\s\S]*3\. Alama zangu[\s\S]*4\. Ongeza mtoto/);
});

test('a parent applies in three presses and is told their case and place', (t) => {
  const db = seeded(t);
  const phone = phoneOf(db, DEMO_CHILD);
  const index = childIndexFor(db, phone, DEMO_CHILD);
  const before = listCurrentCases(db, OPEN_ROUND).length;

  const reply = dial(db, phone, ['1', index, '1']);
  assert.equal(reply.type, 'END');
  const created = listCurrentCases(db, OPEN_ROUND);
  assert.equal(created.length, before + 1);
  const record = created.find((c) => c.childId === DEMO_CHILD)!;
  assert.ok(reply.text.includes(record.id), 'reply names the case id');
  const ranked = rankRound(db, OPEN_ROUND);
  const entry = ranked.find((e) => e.caseId === record.id)!;
  assert.ok(reply.text.includes(String(entry.position)), 'reply names the queue position');
  assert.equal(record.actorRole, 'parent');
  assert.equal(record.currentStage, 'applied');
});

test('declining consent creates nothing at all', (t) => {
  const db = seeded(t);
  const phone = phoneOf(db, DEMO_CHILD);
  const index = childIndexFor(db, phone, DEMO_CHILD);
  const cases = () => (db.prepare('SELECT COUNT(*) AS n FROM cases').get() as { n: number }).n;
  const evidence = () => (db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n;
  const before = [cases(), evidence()];

  const consent = respond(db, { phoneNumber: phone, text: `1*${index}` });
  assert.equal(consent.type, 'CON');
  assert.match(consent.text, /agree|Nakubali/i);

  const reply = dial(db, phone, ['1', index, '2']);
  assert.equal(reply.type, 'END');
  assert.match(reply.text, /No application was made|Hakuna ombi/i);
  assert.deepEqual([cases(), evidence()], before);
});

test('a child who already applied is told so, with the case and place', (t) => {
  const db = seeded(t);
  const applied = listCurrentCases(db, OPEN_ROUND)[0];
  const phone = phoneOf(db, applied.childId);
  const index = childIndexFor(db, phone, applied.childId);
  const reply = dial(db, phone, ['1', index]);
  assert.equal(reply.type, 'END');
  assert.match(reply.text, /already applied|tayari ameomba/i);
  assert.ok(reply.text.includes(applied.id));
});

test('my place reports position, need and waiting bonus', (t) => {
  const db = seeded(t);
  const entry = rankRound(db, OPEN_ROUND).find((e) => e.waitingBonus > 0)!;
  const phone = phoneOf(db, entry.childId);
  const reply = dial(db, phone, ['2', childIndexFor(db, phone, entry.childId)]);
  assert.equal(reply.type, 'END');
  for (const value of [entry.position, entry.need, entry.waitingBonus, entry.priority]) {
    assert.ok(reply.text.includes(String(value)), `missing ${value} in: ${reply.text}`);
  }
});

test('my score gives the parent the breakdown the public page never shows', (t) => {
  const db = seeded(t);
  const record = listCurrentCases(db, OPEN_ROUND)[0];
  const phone = phoneOf(db, record.childId);
  const reply = dial(db, phone, ['3', childIndexFor(db, phone, record.childId)]);
  const score = scoreNeed(record.evidence);
  assert.equal(reply.type, 'END');
  assert.ok(reply.text.includes(`${score.total}/100`));
  for (const component of score.components) assert.ok(reply.text.includes(String(component.points)));
});

test('a child with no case is told to apply instead of shown a place', (t) => {
  const db = seeded(t);
  const phone = phoneOf(db, DEMO_CHILD);
  const index = childIndexFor(db, phone, DEMO_CHILD);
  for (const choice of ['2', '3']) {
    const reply = dial(db, phone, [choice, index]);
    assert.equal(reply.type, 'END');
    assert.match(reply.text, /no application|hana ombi/i);
  }
});

test('adding a child records a verification request and says what to bring', (t) => {
  const db = seeded(t);
  const phone = '+254700000001';
  const before = listVerificationRequests(db, phone).length;
  const reply = dial(db, phone, ['4']);
  assert.equal(reply.type, 'END');
  assert.match(reply.text, /admission letter|barua ya usajili/i);
  const requests = listVerificationRequests(db, phone);
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1)!.actorRole, 'parent');
});

test('a wrong choice re-prompts without losing the session', (t) => {
  const db = seeded(t);
  const phone = '+254700000001';
  const menu = respond(db, { phoneNumber: phone, text: '9' });
  assert.equal(menu.type, 'CON');
  assert.match(menu.text, /Wrong choice|Chaguo si sahihi/i);
  assert.match(menu.text, /1\. Apply|1\. Omba/);

  const child = respond(db, { phoneNumber: phone, text: '1*99' });
  assert.equal(child.type, 'CON');
  assert.match(child.text, /Choose a child|Chagua mtoto/i);

  const consent = respond(db, { phoneNumber: phoneOf(db, DEMO_CHILD), text: `1*${childIndexFor(db, phoneOf(db, DEMO_CHILD), DEMO_CHILD)}*7` });
  assert.equal(consent.type, 'CON');
  assert.match(consent.text, /agree|Nakubali/i);
});

test('when no round is open the parent is told when to check back', (t) => {
  const db = seeded(t);
  db.prepare(
    "INSERT INTO round_events (round_id, type, actor_id, actor_role, at) VALUES (?, 'closed', 'CLERK-01', 'clerk', ?)",
  ).run(OPEN_ROUND, '2026-09-01T08:00:00.000Z');
  const reply = respond(db, { phoneNumber: '+254700000001', text: '' });
  assert.equal(reply.type, 'END');
  assert.match(reply.text, /No bursary round is open/i);
});

test('every screen of a Swahili session fits and is in Swahili', (t) => {
  const db = seeded(t);
  const swahili = db.prepare("SELECT phone FROM households WHERE language = 'sw' LIMIT 1").get() as { phone: string };
  const child = db
    .prepare('SELECT c.id AS id FROM children c JOIN households h ON h.id = c.household_id WHERE h.phone = ? ORDER BY c.id LIMIT 1')
    .get(swahili.phone) as { id: string };
  const reply = dial(db, swahili.phone, ['2', childIndexFor(db, swahili.phone, child.id)]);
  assert.equal(reply.type, 'END');
  assert.match(reply.text, /nafasi|hana ombi/i);
});

test('a long reply is trimmed to the screen limit', () => {
  const wire = renderReply({ type: 'END', text: 'x'.repeat(500) });
  assert.equal(wire.length, MAX_SCREEN);
  assert.ok(wire.startsWith('END '));
  assert.ok(wire.endsWith('...'));
});

test('a registered household with no child on file is not trapped in an empty menu', (t) => {
  const db = seeded(t);
  db.prepare("INSERT INTO households (id, guardian_name, phone, language) VALUES ('HH-NEW', 'New Guardian', '+254700000900', 'en')").run();
  const reply = dial(db, '+254700000900', ['1']);
  assert.equal(reply.type, 'END');
  assert.match(reply.text, /admission letter/i);
  const requests = listVerificationRequests(db, '+254700000900');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reason, 'new_child');
});

test('a long child list keeps every option on one screen', (t) => {
  const db = seeded(t);
  db.prepare("INSERT INTO households (id, guardian_name, phone, language) VALUES ('HH-BIG', 'Big Household', '+254700000901', 'en')").run();
  for (let i = 0; i < 8; i++) {
    db.prepare('INSERT INTO children (id, household_id, school_id, name, admission_no) VALUES (?, ?, ?, ?, ?)').run(
      `CH-BIG-${i}`, 'HH-BIG', 'SCH-1', `Wanjiru Kariuki Number ${i}`, `ADM-BIG-${i}`,
    );
  }
  const reply = respond(db, { phoneNumber: '+254700000901', text: '1' });
  checkScreen(reply);
  for (let i = 1; i <= 8; i++) assert.match(reply.text, new RegExp(`(^|\\n)${i}\\. `), `option ${i} missing`);
});

test('a phone number with stray spaces still finds the household and its requests', (t) => {
  const db = seeded(t);
  const reply = dial(db, ' +254700000001 ', ['4']);
  assert.equal(reply.type, 'END');
  assert.equal(listVerificationRequests(db, '+254700000001').length, 1);
});

test('pressing add-a-child twice does not queue two visits', (t) => {
  const db = seeded(t);
  dial(db, '+254700000001', ['4']);
  dial(db, '+254700000001', ['4']);
  assert.equal(listVerificationRequests(db, '+254700000001').length, 1);
});

test('applying on evidence older than six months asks for a fresh visit', (t) => {
  const db = seeded(t);
  const phone = phoneOf(db, DEMO_CHILD);
  const index = childIndexFor(db, phone, DEMO_CHILD);
  const reply = dial(db, phone, ['1', index, '1']);
  assert.equal(reply.type, 'END');
  const stale = listVerificationRequests(db, phone).filter((r) => r.reason === 'stale_evidence');
  assert.equal(stale.length, 1, 'seeded evidence is months old, so a re-visit must be requested');
  assert.equal(stale[0].childId, DEMO_CHILD);
});

test('the score screen reports the evidence the case was ranked on', (t) => {
  const db = seeded(t);
  const record = listCurrentCases(db, OPEN_ROUND).find((c) => c.childId === 'CH-005')!;
  const phone = phoneOf(db, 'CH-005');
  const reply = dial(db, phone, ['3', childIndexFor(db, phone, 'CH-005')]);
  const score = scoreNeed(record.evidence);
  assert.ok(reply.text.includes(`${score.total}/100`), `${reply.text} should carry ${score.total}`);
});

test('evidence inside the freshness window asks for no re-visit', (t) => {
  const db = seeded(t);
  const phone = phoneOf(db, DEMO_CHILD);
  const index = childIndexFor(db, phone, DEMO_CHILD);
  // The seeded capture is from the 2026 Term 1 round; pretend we are a week later.
  const justAfter = Date.parse('2026-01-12T08:00:00.000Z');
  for (const keys of [['1'], ['1', index], ['1', index, '1']]) {
    respond(db, { phoneNumber: phone, text: keys.join('*'), now: justAfter });
  }
  assert.deepEqual(listVerificationRequests(db, phone).filter((r) => r.reason === 'stale_evidence'), []);
});

test('unreadable capture dates count as stale', () => {
  assert.equal(isStale('not a date', Date.parse('2026-09-18T00:00:00.000Z')), true);
  assert.equal(isStale('2026-09-17T00:00:00.000Z', Date.parse('2026-09-18T00:00:00.000Z')), false);
});

test('a household of twenty children can still reach every child', (t) => {
  const db = seeded(t);
  db.prepare("INSERT INTO households (id, guardian_name, phone, language) VALUES ('HH-20', 'Twenty', '+254700000902', 'en')").run();
  for (let i = 0; i < 20; i++) {
    db.prepare('INSERT INTO children (id, household_id, school_id, name, admission_no) VALUES (?, ?, ?, ?, ?)').run(
      `CH-20-${i}`, 'HH-20', 'SCH-1', `Wanjiru Kariuki Number ${i}`, `ADM-20-${i}`,
    );
  }
  const offered = new Set<number>();
  let keys = ['1'];
  for (let page = 0; page < 10; page++) {
    const reply = respond(db, { phoneNumber: '+254700000902', text: keys.join('*') });
    checkScreen(reply);
    for (const match of reply.text.matchAll(/(?:^|\n)(\d+)\. /g)) offered.add(Number(match[1]));
    if (!/0\. More/.test(reply.text)) break;
    keys.push('0');
  }
  offered.delete(0);
  assert.equal(offered.size, 20, `only offered: ${[...offered].sort((a, b) => a - b).join(',')}`);

  // A number from an earlier page is not accepted while a later page is shown.
  const reprompt = respond(db, { phoneNumber: '+254700000902', text: '1*0*1' });
  assert.equal(reprompt.type, 'CON');
  assert.match(reprompt.text, /Wrong choice/);
});

test('checking a place with no children on file does not queue a home visit', (t) => {
  const db = seeded(t);
  db.prepare("INSERT INTO households (id, guardian_name, phone, language) VALUES ('HH-EMPTY', 'Empty', '+254700000903', 'en')").run();
  const reply = dial(db, '+254700000903', ['2']);
  assert.equal(reply.type, 'END');
  assert.equal(listVerificationRequests(db, '+254700000903').length, 0);
});

test('a number posted with an unencoded plus still finds the household', (t) => {
  const db = seeded(t);
  // `phoneNumber=+254...` decodes to a leading space when a gateway does not encode the plus.
  const reply = respond(db, { phoneNumber: ' 254700000001', text: '' });
  assert.equal(reply.type, 'CON');
  assert.match(reply.text, /1\. Apply/);
});

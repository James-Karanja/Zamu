import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..');
const workingDb = join(root, 'data/zamu.db');

interface DemoRun {
  stdout: string;
  code: number;
}

/** Runs the demo exactly as the recording will, with the same Node that runs the tests. */
async function runDemo(): Promise<DemoRun> {
  try {
    const { stdout } = await run(process.execPath, ['src/demo/run.ts'], { cwd: root, timeout: 120_000 });
    return { stdout, code: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? '', code: typeof failure.code === 'number' ? failure.code : 1 };
  }
}

/** The working database and its WAL, byte for byte, or null where absent. */
function snapshotWorkingDb(): (Buffer | null)[] {
  return ['', '-wal'].map((suffix) => (existsSync(workingDb + suffix) ? readFileSync(workingDb + suffix) : null));
}

let first: DemoRun;
let second: DemoRun;
let workingBefore: (Buffer | null)[];
let workingAfter: (Buffer | null)[];

before(async () => {
  workingBefore = snapshotWorkingDb();
  first = await runDemo();
  second = await runDemo();
  workingAfter = snapshotWorkingDb();
});

test('the demo plays all five acts, in order, and every check holds', () => {
  assert.equal(first.code, 0, `demo exited ${first.code}:\n${first.stdout}`);
  assert.match(first.stdout, /All acts held/);
  assert.doesNotMatch(first.stdout, /✗|FAILED/, 'a failed check would be visible on camera');
  const positions = [1, 2, 3, 4, 5].map((n) => first.stdout.indexOf(`ACT ${n} `));
  assert.ok(positions.every((p) => p >= 0), 'every act is printed');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'acts run in story order');
});

test('what the recording script points at is really on screen', () => {
  const out = first.stdout;
  const script = readFileSync(join(root, 'docs/demo-script.md'), 'utf8');
  // Every backticked quote the presenter is told to point at must appear in the output.
  const pointAt = [...script.matchAll(/\*\*Point at:\*\*([^\n]+)/g)].flatMap((m) => [...m[1].matchAll(/`([^`]+)`/g)].map((q) => q[1]));
  assert.ok(pointAt.length >= 4, 'the script names things to point at');
  for (const quote of pointAt) assert.ok(out.includes(quote), `script points at "${quote}", which the demo does not print`);
});

test('the story on screen agrees with itself', () => {
  const out = first.stdout;
  assert.match(out, /ni zamu yako|your turn/, 'act 1 is a "your turn" message');
  assert.match(out, /waiting \+10/, 'the queue shows the wait the SMS promised');
  assert.match(out, /The database answers: {3}immutable record/);
  assert.match(out, /\(original\)/);
  assert.match(out, /Simulated:/, 'unbuilt steps are labelled as simulated');
});

test('running the demo twice prints the same thing', () => {
  assert.equal(second.code, 0);
  // The correction's capture time is the one value allowed to differ between runs.
  const stable = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>');
  assert.equal(stable(second.stdout), stable(first.stdout));
});

test('the demo never touches the working database', () => {
  assert.deepEqual(
    workingAfter.map((b) => b?.length ?? null),
    workingBefore.map((b) => b?.length ?? null),
    'data/zamu.db was created or resized by the demo',
  );
  workingBefore.forEach((b, i) => {
    if (b) assert.ok(b.equals(workingAfter[i]!), 'data/zamu.db changed while the demo ran');
  });
});

test('the README documents the commands that exist', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
  for (const command of ['seed', 'demo', 'web', 'ussd', 'sms']) {
    assert.ok(scripts[command], `package.json is missing ${command}`);
    assert.ok(readme.includes(`npm run ${command}`), `README omits npm run ${command}`);
  }
  assert.ok(readme.includes('npm test'));
  assert.match(readme, /Not built/);
  assert.match(readme, /Known limitations/);
});

test('no tracked file carries a phone number outside the demo range or a credential', async () => {
  const { stdout } = await run('git', ['ls-files'], { cwd: root });
  const files = stdout.split('\n').filter((f) => /\.(ts|md|sql|json|yaml|txt)$/.test(f) && !f.startsWith('.claude/') && !f.startsWith('.agents/') && !f.startsWith('_bmad/'));
  const phone = /(?:\+|%2B)?254\d{9}\b/g;
  const demoRange = /^(?:\+|%2B)?254700000\d{3}$/;
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const number of text.match(phone) ?? []) assert.match(number, demoRange, `${file} carries ${number}`);
    assert.doesNotMatch(text, /AT_API_KEY\s*=\s*['"]?[A-Za-z0-9]{8,}/, `${file} carries a credential`);
  }
});

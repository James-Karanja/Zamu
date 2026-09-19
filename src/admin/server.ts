// The staff dashboard server. Unlike the public queue it writes, so it binds to localhost, checks that
// every request really comes from its own pages, and sends every write through the store, where the
// role rules are enforced against the staff registry.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { listRounds, rankRound, roundSummary } from '../queue/ranking.ts';
import { queuePending } from '../sms/dispatch.ts';
import {
  AlreadySupersededError, BudgetExceededError, CaseNotFoundError, InvalidAmountError, InvalidTimestampError,
  InvalidTransitionError, MissingReasonError, RoleNotPermittedError, RoundNotFoundError, RoundNotOpenError,
  RoundStateError, checkPermitted, closeRound, createRound, getCase, listRefusedActions, openRound, recordAward,
  recordStage, recordUnregisteredAttempt, type Actor,
} from '../store/cases.ts';
import { getStaff, listStaff, type StaffMember } from '../store/registry.ts';
import { type Notice, renderError, renderHome, renderRefused, renderRound } from './render.ts';

const HTML = 'text/html; charset=utf-8';
const MAX_BODY = 8 * 1024;
const HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // Not `no-referrer`: that makes browsers send `Origin: null` on the dashboard's own form posts,
  // which the origin check below would then refuse. `same-origin` keeps the real origin in-site
  // and still sends nothing to other sites.
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};

/** Errors that are rule outcomes, shown to staff as a banner rather than a failure. */
const RULE_ERRORS = [
  RoleNotPermittedError, MissingReasonError, BudgetExceededError, InvalidTransitionError, InvalidAmountError,
  InvalidTimestampError, RoundNotOpenError, RoundStateError, AlreadySupersededError,
];

class BadRequest extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DashboardOptions {
  /** Fixed secret for tests; a fresh one per process otherwise, so tokens die with the server. */
  secret?: Buffer;
}

export function createServer(db: DatabaseSync, options: DashboardOptions = {}): Server {
  const secret = options.secret ?? randomBytes(32);
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('base64url');
  /** Every form carries this; a page on another site cannot read it, so it cannot forge a post. */
  const formToken = sign('form');
  const matches = (given: string | null, expected: string) => {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  function send(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': HTML, ...HEADERS });
    res.end(body);
  }

  /** Result banners are signed, so a crafted link cannot show a fake "done". */
  function redirect(res: ServerResponse, path: string, actor: StaffMember, notice: Notice): void {
    const query = new URLSearchParams({ as: actor.id, kind: notice.kind, notice: notice.text, sig: sign(`${notice.kind}\n${notice.text}`) });
    res.writeHead(303, { location: `${path}?${query}`, ...HEADERS });
    res.end();
  }

  function noticeFrom(url: URL): Notice | undefined {
    const text = url.searchParams.get('notice');
    const kind = url.searchParams.get('kind') === 'refused' ? 'refused' : 'ok';
    if (!text || !matches(url.searchParams.get('sig'), sign(`${kind}\n${text}`))) return undefined;
    return { kind, text };
  }

  /** Only the dashboard's own address may reach it: a rebound hostname or another site's page may not. */
  function checkOrigin(req: IncomingMessage): void {
    const port = req.socket.localPort;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    const host = req.headers.host ?? '';
    if (!allowed.includes(host)) throw new BadRequest(400, 'This dashboard only answers on its own local address.');
    if (req.method !== 'POST') return;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new BadRequest(403, 'Actions must come from the dashboard itself.');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new BadRequest(403, 'Actions must come from the dashboard itself.');
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      throw new BadRequest(415, 'Actions must be submitted from the dashboard forms.');
    }
  }

  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
      req.resume();
      throw new BadRequest(413, 'That request was too large.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    // Keep reading past the limit (discarding), so the client gets a 413 rather than a reset connection.
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY) tooLarge = true;
      else chunks.push(buffer);
    }
    if (tooLarge) throw new BadRequest(413, 'That request was too large.');
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  const asActor = (member: StaffMember): Actor => ({ id: member.id, role: member.role });

  /** Runs one staff action. Rule outcomes become banners; anything else is a real failure. */
  function act(res: ServerResponse, back: string, member: StaffMember, run: () => string): void {
    try {
      redirect(res, back, member, { kind: 'ok', text: run() });
    } catch (err) {
      if (RULE_ERRORS.some((type) => err instanceof type)) {
        redirect(res, back, member, { kind: 'refused', text: (err as Error).message });
        return;
      }
      throw err;
    }
  }

  /** Whole-shilling amounts only: `1e4`, `0x2EE0` and padded text are not amounts. */
  function parseAmount(raw: string | null): number {
    const text = (raw ?? '').trim();
    if (!/^\d{1,9}$/.test(text)) throw new InvalidAmountError(Number.NaN);
    return Number(text);
  }

  const view = { token: formToken };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    checkOrigin(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new BadRequest(404, 'That page does not exist.');
    }
    const staff = listStaff(db);

    if (req.method === 'GET') {
      const actor = url.searchParams.get('as') ? getStaff(db, url.searchParams.get('as')!) : undefined;
      if (path === '/') return send(res, 200, renderHome(listRounds(db), actor, staff, view, noticeFrom(url)));
      if (path === '/refused') return send(res, 200, renderRefused(listRefusedActions(db), actor, staff, view));
      const round = /^\/round\/([^/]+)$/.exec(path);
      if (round) {
        try {
          const entries = rankRound(db, round[1]);
          const reasons = new Map(
            entries.filter((e) => e.stage === 'rejected').map((e) => [e.caseId, getCase(db, e.caseId).events.at(-1)?.note ?? '']),
          );
          return send(res, 200, renderRound(roundSummary(db, round[1]), entries, reasons, actor, staff, view, noticeFrom(url)));
        } catch (err) {
          if (err instanceof RoundNotFoundError) throw new BadRequest(404, 'That round does not exist.');
          throw err;
        }
      }
      throw new BadRequest(404, 'That page does not exist.');
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': HTML, allow: 'GET, POST', ...HEADERS });
      res.end(renderError('Not allowed', 'Use the forms on the dashboard.', staff, view));
      return;
    }

    const form = await readForm(req);
    if (!matches(form.get('token'), formToken)) throw new BadRequest(403, 'Actions must come from the dashboard itself.');

    // The acting person must exist in the registry; their role comes from there, never from the form.
    const claimed = form.get('as') ?? '';
    const member = claimed ? getStaff(db, claimed) : undefined;
    if (!member) {
      if (claimed) recordUnregisteredAttempt(db, claimed, path, 'act as staff');
      throw new BadRequest(400, 'Choose yourself from the staff list at the top of the page first.');
    }
    const actor = asActor(member);

    if (path === '/rounds') {
      return act(res, '/', member, () => {
        const name = (form.get('name') ?? '').trim();
        const ward = (form.get('ward') ?? '').trim();
        if (!name || !ward) throw new RoundStateError('(new)', 'a round needs a name and a ward');
        const id = `R-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
        if (listRounds(db).some((r) => r.id === id)) throw new RoundStateError(id, 'a round with that name already exists');
        createRound(db, { id, name, ward, currency: 'KES', budget: parseAmount(form.get('budget')) }, actor);
        return `${name} created. Open it when applications should start.`;
      });
    }

    const roundAction = /^\/round\/([^/]+)\/(open|close)$/.exec(path);
    if (roundAction) {
      const [, roundId, verb] = roundAction;
      try {
        roundSummary(db, roundId);
      } catch (err) {
        if (err instanceof RoundNotFoundError) throw new BadRequest(404, 'That round does not exist.');
        throw err;
      }
      return act(res, '/', member, () => {
        if (verb === 'open') openRound(db, roundId, actor);
        else closeRound(db, roundId, actor);
        return `${roundId} ${verb === 'open' ? 'opened' : 'closed'}.`;
      });
    }

    const caseAction = /^\/case\/([^/]+)\/(verify|reject|award|pay|confirm)$/.exec(path);
    if (caseAction) {
      const [, caseId, verb] = caseAction;
      let roundId: string;
      try {
        roundId = getCase(db, caseId).roundId;
      } catch (err) {
        if (err instanceof CaseNotFoundError) throw new BadRequest(404, 'That case does not exist.');
        throw err;
      }
      return act(res, `/round/${encodeURIComponent(roundId)}`, member, () => {
        switch (verb) {
          case 'verify':
            recordStage(db, caseId, 'verified', actor);
            return `${caseId} verified.`;
          case 'reject':
            recordStage(db, caseId, 'rejected', actor, undefined, form.get('note') ?? '');
            return `${caseId} rejected.`;
          case 'award': {
            const amount = parseAmount(form.get('amount'));
            recordAward(db, caseId, amount, actor);
            return `${caseId} awarded ${amount}.`;
          }
          case 'pay':
            recordStage(db, caseId, 'disbursed', actor);
            return `${caseId} marked paid to the school.`;
          default:
            recordStage(db, caseId, 'school_confirmed', actor);
            return `${caseId}: the school confirmed receipt.`;
        }
      });
    }

    if (path === '/sms') {
      // Queue only: marking messages "sent" here would stop a later live run from ever delivering them.
      return act(res, '/', member, () => {
        checkPermitted(db, actor, 'sms queue', 'dispatch_sms');
        const queued = queuePending(db);
        return `Queued ${queued} SMS. Run \`npm run sms\` to send them.`;
      });
    }

    throw new BadRequest(404, 'That action does not exist.');
  }

  return createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent || res.destroyed || res.writableEnded) {
        res.destroy();
        return;
      }
      if (err instanceof BadRequest) {
        let staff: StaffMember[] = [];
        try {
          staff = listStaff(db);
        } catch {
          // A broken database still gets a plain error page.
        }
        send(res, err.status, renderError(err.status === 404 ? 'Not found' : 'Request refused', err.message, staff, view));
        return;
      }
      console.error('Dashboard request failed:', err);
      send(res, 500, renderError('Something went wrong', 'The action was not completed.', [], view));
    });
  });
}

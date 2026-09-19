// The staff dashboard: server-rendered forms, no client JavaScript. Internal — full names appear here,
// which is why the server binds to localhost and the public page is a separate, read-only server.
import type { QueueEntry, RoundSummary } from '../queue/ranking.ts';
import type { RefusedAction, Stage } from '../store/cases.ts';
import type { StaffMember } from '../store/registry.ts';
import { escapeHtml } from '../web/render.ts';

const money = (amount: number, currency = 'KES') =>
  `${currency} ${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

const ROLE_LABELS: Record<string, string> = {
  clerk: 'Clerk',
  committee: 'Bursary committee',
  chv: 'Community health volunteer',
  teacher: 'Teacher',
  school: 'School bursar',
};

const STAGE_LABELS: Record<Stage, string> = {
  applied: 'Applied',
  verified: 'Verified',
  approved: 'Awarded',
  disbursed: 'Paid to school',
  school_confirmed: 'School confirmed',
  rejected: 'Rejected',
};

const CSS = `
:root { color-scheme: light; --line: #d8d2c4; --muted: #5f6b64; --ink: #1b2a22; --accent: #14532d; --paper: #f6f2ea; --card: #fffdf8; --ok: #14532d; --bad: #8a1c1c; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 24px 48px; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
header { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; justify-content: space-between; padding: 12px 0 16px; border-bottom: 1px solid var(--line); margin-bottom: 20px; }
h1 { font-size: 1.4rem; margin: 0; } h2 { font-size: 1.15rem; margin: 24px 0 8px; }
.who { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
.who strong { color: var(--accent); }
.banner { padding: 12px 16px; border-radius: 8px; margin: 0 0 16px; border: 1px solid; }
.banner.ok { background: #e8f3ec; border-color: #9cc5ab; color: var(--ok); }
.banner.refused { background: #fbeaea; border-color: #e0a3a3; color: var(--bad); }
.facts { display: flex; flex-wrap: wrap; gap: 12px; padding: 0; list-style: none; margin: 0 0 16px; }
.facts li { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
.facts strong { display: block; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; background: var(--card); }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
form.inline { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 2px 8px 4px 0; }
td.actions { min-width: 22rem; }
input[type=text], input[type=number], select { font: inherit; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
input[type=number] { width: 7.5em; }
button { font: inherit; padding: 4px 10px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
button.quiet { background: transparent; color: var(--accent); }
.owner { font-size: .8rem; color: var(--muted); }
a { color: var(--accent); }
nav a { margin-right: 16px; }
.note { color: var(--muted); font-size: .9rem; }
`;

export interface Notice {
  kind: 'ok' | 'refused';
  text: string;
}

/** What every page needs from the server: the token each form must carry. */
export interface View {
  token: string;
}

function page(title: string, actor: StaffMember | undefined, staff: StaffMember[], body: string, notice?: Notice): string {
  const noStaff = staff.length === 0
    ? '<p class="banner refused" role="status">No staff are registered in this database. Run <code>npm run seed</code> (or re-seed a database made before staff existed).</p>'
    : '';
  const options = staff
    .map((s) => `<option value="${escapeHtml(s.id)}"${actor?.id === s.id ? ' selected' : ''}>${escapeHtml(s.name)} — ${escapeHtml(ROLE_LABELS[s.role] ?? s.role)}</option>`)
    .join('');
  const who = actor
    ? `Acting as <strong>${escapeHtml(actor.name)}</strong> · ${escapeHtml(ROLE_LABELS[actor.role] ?? actor.role)}`
    : '<strong>Choose who you are</strong> before acting';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
<main>
<header>
  <div><h1>Zamu staff dashboard</h1><nav><a href="/${actor ? `?as=${encodeURIComponent(actor.id)}` : ''}">Rounds</a><a href="/refused${actor ? `?as=${encodeURIComponent(actor.id)}` : ''}">Refused actions</a></nav></div>
  <form class="who" method="get" action="">
    <span>${who}</span>
    <select name="as" aria-label="Who is acting">${options}</select>
    <button class="quiet" type="submit">Switch</button>
  </form>
</header>
${noStaff}${notice ? `<p class="banner ${notice.kind}" role="status">${escapeHtml(notice.text)}</p>` : ''}
${body}
<p class="note">Internal, localhost only. Role rules are enforced for every action; who you are is on trust — there is no login in this proof of concept.</p>
</main>
</html>
`;
}

const hidden = (view: View, actor?: StaffMember) =>
  `<input type="hidden" name="token" value="${escapeHtml(view.token)}">` +
  (actor ? `<input type="hidden" name="as" value="${escapeHtml(actor.id)}">` : '');

export function renderHome(rounds: RoundSummary[], actor: StaffMember | undefined, staff: StaffMember[], view: View, notice?: Notice): string {
  const rows = rounds
    .map((r) => {
      const control =
        r.status === 'not_opened'
          ? `<form class="inline" method="post" action="/round/${encodeURIComponent(r.id)}/open">${hidden(view, actor)}<button type="submit">Open round</button></form><span class="owner">clerk</span>`
          : r.status === 'open'
            ? `<form class="inline" method="post" action="/round/${encodeURIComponent(r.id)}/close">${hidden(view, actor)}<button type="submit">Close round</button></form><span class="owner">clerk</span>`
            : 'Closed';
      return `<tr>
  <td><a href="/round/${encodeURIComponent(r.id)}${actor ? `?as=${encodeURIComponent(actor.id)}` : ''}">${escapeHtml(r.name)}</a></td>
  <td>${escapeHtml(r.status.replace('_', ' '))}</td>
  <td class="num">${r.applicants}</td>
  <td class="num">${r.recipients}</td>
  <td class="num">${escapeHtml(money(r.awarded, r.currency))} of ${escapeHtml(money(r.budget, r.currency))}</td>
  <td>${control}</td>
</tr>`;
    })
    .join('\n');
  const body = `<h2>Rounds</h2>
<table>
<thead><tr><th>Round</th><th>Status</th><th class="num">Applicants</th><th class="num">Recipients</th><th class="num">Awarded</th><th></th></tr></thead>
<tbody>
${rows}
</tbody></table>
<h2>New round</h2>
<form class="inline" method="post" action="/rounds">${hidden(view, actor)}
  <input type="text" name="name" placeholder="Name, e.g. 2026 Term 3" aria-label="Round name" required>
  <input type="text" name="ward" value="${escapeHtml(rounds[0]?.ward ?? '')}" aria-label="Ward" required>
  <input type="number" name="budget" min="1" step="1" placeholder="Budget, KES" aria-label="Budget in KES" required>
  <button type="submit">Create round</button><span class="owner">clerk</span>
</form>
<h2>Messages</h2>
<form class="inline" method="post" action="/sms">${hidden(view, actor)}<button type="submit">Queue pending SMS</button><span class="owner">clerk</span></form>
<span class="note">Writes a message for every decision not yet messaged. Sending is separate: <code>npm run sms</code>.</span>`;
  return page('Zamu staff dashboard', actor, staff, body, notice);
}

function actionsFor(entry: QueueEntry, actor: StaffMember | undefined, remaining: number, currency: string, view: View): string {
  const post = (action: string, button: string, owner: string, field = '') =>
    `<form class="inline" method="post" action="/case/${encodeURIComponent(entry.caseId)}/${action}">${hidden(view, actor)}${field}<button type="submit">${button}</button><span class="owner">${owner}</span></form>`;
  const reject = post('reject', 'Reject', 'committee', '<input type="text" name="note" maxlength="50" placeholder="Reason, 50 characters" aria-label="Reason for rejecting">');
  switch (entry.stage) {
    case 'applied':
      return post('verify', 'Verify', 'volunteer or teacher') + reject;
    case 'verified':
      return (
        post('award', 'Award', 'committee', `<input type="number" name="amount" min="1" step="1" max="${remaining}" placeholder="${escapeHtml(currency)}" aria-label="Amount to award">`) +
        reject
      );
    case 'approved':
      return post('pay', 'Mark paid', 'clerk');
    case 'disbursed':
      return post('confirm', 'Confirm receipt', 'the child’s own school');
    default:
      return '<span class="note">Complete</span>';
  }
}

export function renderRound(
  summary: RoundSummary,
  entries: QueueEntry[],
  reasons: Map<string, string>,
  actor: StaffMember | undefined,
  staff: StaffMember[],
  view: View,
  notice?: Notice,
): string {
  const remaining = summary.budget - summary.awarded;
  const rows = entries
    .map(
      (e) => `<tr>
  <td class="num">${e.position}</td>
  <td>${escapeHtml(e.name)}<div class="note">${escapeHtml(e.caseId)} · ${escapeHtml(e.school)}</div></td>
  <td class="num">${e.need}</td>
  <td class="num">${e.waitingBonus ? `+${e.waitingBonus}` : '—'}</td>
  <td class="num"><strong>${e.priority}</strong></td>
  <td>${escapeHtml(STAGE_LABELS[e.stage])}${e.awardAmount ? `<div class="note">${escapeHtml(money(e.awardAmount, summary.currency))}</div>` : ''}${reasons.get(e.caseId) ? `<div class="note">Reason: ${escapeHtml(reasons.get(e.caseId)!)}</div>` : ''}</td>
  <td class="actions">${summary.status === 'open' || e.stage === 'approved' || e.stage === 'disbursed' ? actionsFor(e, actor, remaining, summary.currency, view) : '<span class="note">Round not open</span>'}</td>
</tr>`,
    )
    .join('\n');
  const body = `<h2>${escapeHtml(summary.name)} — ${escapeHtml(summary.ward)} (${escapeHtml(summary.status.replace('_', ' '))})</h2>
<ul class="facts">
  <li>Budget <strong>${escapeHtml(money(summary.budget, summary.currency))}</strong></li>
  <li>Awarded <strong>${escapeHtml(money(summary.awarded, summary.currency))}</strong></li>
  <li>Remaining <strong>${escapeHtml(money(remaining, summary.currency))}</strong></li>
  <li>Recipients <strong>${summary.recipients}</strong> of ${summary.applicants}</li>
</ul>
${entries.length === 0 ? '<p>No applications in this round yet.</p>' : `<div class="scroll"><table>
<thead><tr><th class="num">#</th><th>Applicant</th><th class="num">Need</th><th class="num">Waiting</th><th class="num">Priority</th><th>Stage</th><th>Actions</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`}`;
  return page(`${summary.name} — Zamu staff`, actor, staff, body, notice);
}

export function renderRefused(refused: RefusedAction[], actor: StaffMember | undefined, staff: StaffMember[], _view: View): string {
  const rows = refused
    .map(
      (r) => `<tr><td>${escapeHtml(r.at)}</td><td>${escapeHtml(r.actorId)}<div class="note">${escapeHtml(r.actorRole)}</div></td><td>${escapeHtml(r.attempted)}</td><td>${escapeHtml(r.target)}</td><td>${escapeHtml(r.reason)}</td></tr>`,
    )
    .join('\n');
  const body = `<h2>Refused actions</h2>
<p class="note">Every action the role rules refused, newest first. This log is append-only.</p>
${refused.length === 0 ? '<p>Nothing has been refused.</p>' : `<table>
<thead><tr><th>When</th><th>Who</th><th>Tried</th><th>On</th><th>Why refused</th></tr></thead>
<tbody>
${rows}
</tbody></table>`}`;
  return page('Refused actions — Zamu staff', actor, staff, body);
}

export function renderError(title: string, message: string, staff: StaffMember[], _view: View, actor?: StaffMember): string {
  const back = actor ? `/?as=${encodeURIComponent(actor.id)}` : '/';
  return page(`${title} — Zamu staff`, actor, staff, `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p><a href="${back}">Back to rounds</a></p>`);
}

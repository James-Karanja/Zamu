// Server-rendered HTML: inline CSS, no client JavaScript, nothing fetched from outside,
// so the page opens on a cheap phone over a weak connection.
import type { PublicQueueEntry, RoundStatus, RoundSummary } from '../queue/ranking.ts';
import type { Stage } from '../store/cases.ts';
import { MAX_SCORE } from '../scoring/model.ts';
import { WAITING_BONUS_PER_ROUND } from '../scoring/priority.ts';

const STATUS_LABELS: Record<RoundStatus, string> = {
  not_opened: 'Not open yet',
  open: 'Open',
  closed: 'Closed',
};

const STAGE_LABELS: Record<Stage, string> = {
  applied: 'Applied',
  verified: 'Verified',
  approved: 'Awarded',
  disbursed: 'Paid to school',
  school_confirmed: 'School confirmed',
  rejected: 'Not selected',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const money = (amount: number, currency: string) =>
  `${currency} ${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

const CSS = `
:root { color-scheme: light dark; --line: #d8d8d8; --muted: #5a5a5a; --accent: #14532d; --bg: #fff; --fg: #111; }
@media (prefers-color-scheme: dark) { :root { --line: #333; --muted: #a5a5a5; --accent: #86efac; --bg: #111; --fg: #f2f2f2; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 900px; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
p.lede, .meta { color: var(--muted); margin: 4px 0 16px; font-size: 0.95rem; }
.facts { display: flex; flex-wrap: wrap; gap: 12px; padding: 0; margin: 0 0 20px; list-style: none; }
.facts li { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; min-width: 140px; }
.facts strong { display: block; font-size: 1.1rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); }
th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.awarded td { background: rgba(20, 83, 45, 0.08); }
a { color: var(--accent); }
.tag { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 0.8rem; }
footer { margin-top: 24px; color: var(--muted); font-size: 0.85rem; }
.show-sm { display: none; }
@media (max-width: 560px) {
  .hide-sm { display: none; }
  .show-sm { display: block; }
  body { padding: 12px; }
  table { font-size: 0.9rem; }
  th, td { padding: 8px 4px; }
  .facts li { flex: 1 1 calc(50% - 12px); min-width: 0; }
}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
<main>
${body}
<footer>Zamu — public money made visible, so bursaries are a right, not a favour. Scores follow the published rules; nobody can change a record without leaving a trail.</footer>
</main>
</html>
`;
}

export function renderIndex(rounds: RoundSummary[]): string {
  const rows = rounds
    .map(
      (r) => `<tr>
  <td><a href="/round/${encodeURIComponent(r.id)}">${escapeHtml(r.name)}</a></td>
  <td><span class="tag">${STATUS_LABELS[r.status]}</span></td>
  <td class="num">${r.applicants}</td>
  <td class="num">${r.recipients}</td>
  <td class="num">${escapeHtml(money(r.awarded, r.currency))} / ${escapeHtml(money(r.budget, r.currency))}</td>
</tr>`,
    )
    .join('\n');
  const body = `<h1>Bursary rounds</h1>
<p class="lede">Every round, every place in the queue, and every shilling awarded.</p>
${rounds.length === 0 ? '<p>No rounds yet.</p>' : `<table>
<thead><tr><th>Round</th><th>Status</th><th class="num">Applicants</th><th class="num">Recipients</th><th class="num">Awarded of budget</th></tr></thead>
<tbody>
${rows}
</tbody></table>`}`;
  return page('Zamu — bursary rounds', body);
}

export function renderRound(summary: RoundSummary, entries: PublicQueueEntry[]): string {
  const rows = entries
    .map(
      (e) => `<tr${e.awardAmount ? ' class="awarded"' : ''}>
  <td class="num">${e.position}</td>
  <td>${escapeHtml(e.maskedName)}<div class="meta">${escapeHtml(e.caseId)}</div>
      <div class="meta show-sm">${escapeHtml(STAGE_LABELS[e.stage])}</div></td>
  <td class="hide-sm">${escapeHtml(e.school)}</td>
  <td class="num">${e.need}</td>
  <td class="num">${e.waitingBonus ? `+${e.waitingBonus}` : '—'}</td>
  <td class="num"><strong>${e.priority}</strong></td>
  <td class="hide-sm">${escapeHtml(STAGE_LABELS[e.stage])}</td>
  <td class="num">${e.awardAmount === null ? '—' : escapeHtml(money(e.awardAmount, summary.currency))}</td>
</tr>`,
    )
    .join('\n');

  const body = `<h1>${escapeHtml(summary.name)} — ${escapeHtml(summary.ward)}</h1>
<p class="lede"><a href="/">All rounds</a> · <span class="tag">${STATUS_LABELS[summary.status]}</span> · <a href="/round/${encodeURIComponent(summary.id)}.json">data</a></p>
<ul class="facts">
  <li>Budget <strong>${escapeHtml(money(summary.budget, summary.currency))}</strong></li>
  <li>Awarded <strong>${escapeHtml(money(summary.awarded, summary.currency))}</strong></li>
  <li>Recipients <strong>${summary.recipients}</strong></li>
  <li>Applicants <strong>${summary.applicants}</strong></li>
</ul>
${entries.length === 0 ? '<p>No applications in this round yet.</p>' : `<table>
<thead><tr>
  <th class="num">#</th><th>Applicant</th><th class="hide-sm">School</th>
  <th class="num">Need</th><th class="num">Waiting</th><th class="num">Priority</th><th class="hide-sm">Stage</th><th class="num">Award</th>
</tr></thead>
<tbody>
${rows}
</tbody></table>
<p class="meta">Need is scored from verified household evidence out of ${MAX_SCORE}. Waiting adds ${WAITING_BONUS_PER_ROUND} points for each closed round a child applied in without an award. Names are shortened; a parent sees their own full breakdown on USSD.</p>`}`;
  return page(`${summary.name} — Zamu queue`, body);
}

export function renderNotFound(message: string): string {
  return page('Not found — Zamu', `<h1>Not found</h1><p>${escapeHtml(message)}</p><p><a href="/">All rounds</a></p>`);
}

# Scoring model — Zamu

Deterministic points table. Higher = greater need. No manual input exists.

## Need score (max 100)

| Input | Source | Max | Bands |
|---|---|---|---|
| Fee balance | School record | 35 | KES 0 → 0 · <10,000 → 12 · 10,000–25,000 → 24 · >25,000 → 35 |
| House type | Witnessed evidence | 30 | Permanent (stone/brick) → 0 · semi-permanent → 15 · mud/grass-thatched → 30 |
| Livestock | Witnessed evidence | 20 | 5+ cattle → 0 · 1–4 cattle → 8 · goats/poultry only → 14 · none → 20 |
| Land | Witnessed evidence / title | 15 | >2 acres with title → 0 · 0.5–2 acres → 7 · <0.5 acre or none → 15 |

**Reason text:** the two highest-contributing inputs, e.g. `Score 89/100: fee balance KES 28,000 · mud house`.

## Queue priority

`priority = need score + 10 × consecutive rounds applied without an award`

- Waiting bonus is displayed separately: `Need 72 + waiting 20 = 92`.
- Bonus resets to 0 when the child receives an award; no cap.
- Ties: earlier application first.
- Awards are made in priority order until the round's budget is exhausted.

## Future inputs (configurable, not in PoC)

Household economic activity, orphan/single-parent status, siblings in school, disability, school level.

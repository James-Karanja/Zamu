- source_spec: `_bmad-output/specs/spec-zamu/stories/1-immutable-case-store-and-synthetic-seed-data.md`
  summary: Role authorization — which actor role may record which stage (a parent must not verify their own case; a school must not approve an award).
  evidence: Round-2 review: actor is recorded but never constrained. Belongs with CAP-10 (story 6, role-based stage flow).
- source_spec: `_bmad-output/specs/spec-zamu/stories/1-immutable-case-store-and-synthetic-seed-data.md`
  summary: Closed-round awards in the seed contradict the scoring model (a child scoring 70 unawarded while one scoring 37 was awarded).
  evidence: Verified by hand. Story 1 must not compute scores, so story 2 should re-derive closed-round awards from the scoring engine.
- source_spec: `_bmad-output/specs/spec-zamu/stories/1-immutable-case-store-and-synthetic-seed-data.md`
  summary: No remedy after an award — no revoke/reverse stage, so budget consumed by a fraudulent award can never be released, and rejections carry no required reason.
  evidence: Round-2 review; CORRECTABLE_STAGES stops at verified. Pairs with CAP-9 (anonymous report → independent review).
- source_spec: `_bmad-output/specs/spec-zamu/stories/1-immutable-case-store-and-synthetic-seed-data.md`
  summary: Ward is not enforced — a child at a school in another ward can apply to any ward's round.
  evidence: rounds.ward and schools.ward exist but are never compared; single-ward demo hides it. Needed before multi-ward or multi-county use.
- source_spec: `_bmad-output/specs/spec-zamu/stories/1-immutable-case-store-and-synthetic-seed-data.md`
  summary: Append-only holds against the application, not against file-level tampering (DROP TRIGGER, PRAGMA writable_schema).
  evidence: Round-2 review. A hash chain over events would make tampering detectable — strong pitch material, out of scope for story 1.
- source_spec: `_bmad-output/specs/spec-zamu/stories/1-immutable-case-store-and-synthetic-seed-data.md`
  summary: Data-protection tension — immutable household data with no erasure or rectification path.
  evidence: Round-2 review. Corrections supersede but never remove; Kenya DPA 2019 rights need a documented approach (e.g. redaction of PII, crypto-shredding) in the written summary.
- source_spec: `_bmad-output/specs/spec-zamu/stories/1-immutable-case-store-and-synthetic-seed-data.md`
  summary: Concurrency unproven — no two-connection race test for case-id allocation or round-close races.
  evidence: Round-1 and round-2 reviews; single-process demo. Settle with a test that opens two connections against one file.
- source_spec: `_bmad-output/specs/spec-zamu/stories/1-immutable-case-store-and-synthetic-seed-data.md`
  summary: No schema versioning (PRAGMA user_version) or migrations; later stories changing the schema will silently keep old definitions in an existing data/zamu.db.
  evidence: openDatabase re-runs CREATE ... IF NOT EXISTS. Mitigated today because `npm run seed` rebuilds the file.

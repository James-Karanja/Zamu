-- Zamu schema. Cases, evidence, rounds, and every state change are append-only:
-- triggers below reject UPDATE and DELETE, and `PRAGMA recursive_triggers = ON`
-- (see connection.ts) makes INSERT OR REPLACE fire them too.
--
-- Scope of the guarantee: UPDATE, DELETE and INSERT OR REPLACE are refused on every connection,
-- including a plain sqlite3 session. It is not tamper-proofing against someone who can change the
-- schema itself (DROP TRIGGER, PRAGMA writable_schema). Detecting that needs a hash chain over events.

CREATE TABLE IF NOT EXISTS schools (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL CHECK (length(trim(name)) > 0),
  county TEXT NOT NULL CHECK (length(trim(county)) > 0),
  ward   TEXT NOT NULL CHECK (length(trim(ward)) > 0)
);

CREATE TABLE IF NOT EXISTS households (
  id            TEXT PRIMARY KEY,
  guardian_name TEXT NOT NULL CHECK (length(trim(guardian_name)) > 0),
  phone         TEXT NOT NULL CHECK (length(trim(phone)) > 0),
  language      TEXT NOT NULL CHECK (language IN ('sw', 'en'))
);

-- One household per number: the USSD session has no other way to tell them apart.
-- Declared as an index, not a table constraint, so it also applies to databases
-- created before this rule existed.
CREATE UNIQUE INDEX IF NOT EXISTS households_phone_unique ON households(phone);

CREATE TABLE IF NOT EXISTS children (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  school_id    TEXT NOT NULL REFERENCES schools(id),
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  admission_no TEXT NOT NULL CHECK (length(trim(admission_no)) > 0),
  UNIQUE (school_id, admission_no)
);

CREATE TABLE IF NOT EXISTS rounds (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  ward       TEXT NOT NULL CHECK (length(trim(ward)) > 0),
  currency   TEXT NOT NULL CHECK (length(trim(currency)) > 0),
  budget     INTEGER NOT NULL CHECK (typeof(budget) = 'integer' AND budget >= 0),
  actor_id   TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  actor_role TEXT NOT NULL CHECK (actor_role = 'clerk'),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS round_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id   TEXT NOT NULL REFERENCES rounds(id),
  type       TEXT NOT NULL CHECK (type IN ('opened', 'closed')),
  actor_id   TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('parent', 'chv', 'teacher', 'clerk', 'committee', 'school', 'system')),
  at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id                 TEXT PRIMARY KEY,
  round_id           TEXT NOT NULL REFERENCES rounds(id),
  child_id           TEXT NOT NULL REFERENCES children(id),
  supersedes_case_id TEXT REFERENCES cases(id),
  correction_reason  TEXT CHECK (correction_reason IS NULL OR length(trim(correction_reason)) > 0),
  actor_id           TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  actor_role         TEXT NOT NULL CHECK (actor_role IN ('parent', 'chv', 'teacher', 'clerk', 'committee', 'school', 'system')),
  created_at         TEXT NOT NULL,
  CHECK ((supersedes_case_id IS NULL) = (correction_reason IS NULL)),
  CHECK (supersedes_case_id IS NULL OR supersedes_case_id <> id)
);

-- A case can be superseded at most once.
CREATE UNIQUE INDEX IF NOT EXISTS cases_supersedes_once
  ON cases(supersedes_case_id) WHERE supersedes_case_id IS NOT NULL;

-- One original application per child per round; corrections are the only way to add another.
CREATE UNIQUE INDEX IF NOT EXISTS cases_one_application_per_round
  ON cases(round_id, child_id) WHERE supersedes_case_id IS NULL;

CREATE TABLE IF NOT EXISTS evidence (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id              TEXT NOT NULL UNIQUE REFERENCES cases(id),
  fee_balance          INTEGER NOT NULL CHECK (typeof(fee_balance) = 'integer' AND fee_balance >= 0),
  house_type           TEXT NOT NULL CHECK (house_type IN ('permanent', 'semi_permanent', 'mud')),
  cattle               INTEGER NOT NULL CHECK (typeof(cattle) = 'integer' AND cattle >= 0),
  has_goats_or_poultry INTEGER NOT NULL CHECK (has_goats_or_poultry IN (0, 1)),
  land_acres           REAL NOT NULL CHECK (land_acres >= 0 AND land_acres < 10000),
  has_title            INTEGER NOT NULL CHECK (has_title IN (0, 1)),
  photo_ref            TEXT NOT NULL CHECK (length(trim(photo_ref)) > 0),
  lat                  REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                  REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  captured_by          TEXT NOT NULL CHECK (length(trim(captured_by)) > 0),
  captured_by_role     TEXT NOT NULL CHECK (captured_by_role IN ('chv', 'teacher')),
  captured_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id    TEXT NOT NULL REFERENCES cases(id),
  stage      TEXT NOT NULL CHECK (stage IN ('applied', 'verified', 'approved', 'disbursed', 'school_confirmed', 'rejected')),
  amount     INTEGER CHECK (amount IS NULL OR (typeof(amount) = 'integer' AND amount > 0)),
  note       TEXT,
  actor_id   TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('parent', 'chv', 'teacher', 'clerk', 'committee', 'school', 'system')),
  at         TEXT NOT NULL,
  CHECK ((stage = 'approved') = (amount IS NOT NULL))
);

-- Staff who act on cases. The role recorded on every event is looked up here, never taken from a form.
-- Like the rest of the registry this is editable (people change jobs); identity itself is on trust
-- in the proof of concept, which has no login.
CREATE TABLE IF NOT EXISTS staff (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL CHECK (length(trim(name)) > 0),
  role      TEXT NOT NULL CHECK (role IN ('chv', 'teacher', 'clerk', 'committee', 'school')),
  school_id TEXT REFERENCES schools(id),
  CHECK ((role = 'school') = (school_id IS NOT NULL))
);

-- Every action the role rules refused: who tried, what, on which case or round, and why.
-- Append-only, so a refusal cannot be quietly removed.
CREATE TABLE IF NOT EXISTS refused_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  actor_role TEXT NOT NULL,
  target     TEXT NOT NULL CHECK (length(trim(target)) > 0),
  attempted  TEXT NOT NULL CHECK (length(trim(attempted)) > 0),
  reason     TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  at         TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS refused_actions_no_update BEFORE UPDATE ON refused_actions
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS refused_actions_no_delete BEFORE DELETE ON refused_actions
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS refused_actions_no_replace BEFORE INSERT ON refused_actions
WHEN EXISTS (SELECT 1 FROM refused_actions WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

-- A request is append-only like everything else; when resolution is added it belongs in a
-- companion events table, never as a mutable column here.
CREATE TABLE IF NOT EXISTS verification_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL CHECK (length(trim(phone)) > 0),
  child_id   TEXT REFERENCES children(id),
  round_id   TEXT REFERENCES rounds(id),
  reason     TEXT NOT NULL CHECK (reason IN ('stale_evidence', 'no_evidence', 'new_child')),
  note       TEXT NOT NULL CHECK (length(trim(note)) > 0),
  actor_id   TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('parent', 'chv', 'teacher', 'clerk', 'committee', 'school', 'system')),
  at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS verification_requests_by_phone ON verification_requests(phone);

-- Two volunteers must never be sent to the same household for the same reason in the same
-- round; the check in requestVerification cannot be trusted alone under concurrent writes.
CREATE UNIQUE INDEX IF NOT EXISTS verification_requests_unique
  ON verification_requests(phone, reason, ifnull(child_id, ''), ifnull(round_id, ''))
  WHERE child_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS verification_requests_no_update BEFORE UPDATE ON verification_requests
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS verification_requests_no_delete BEFORE DELETE ON verification_requests
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

-- Messages are records derived from the event log, not side effects of a handler.
-- A message never changes; what happened when we tried to send it is a separate append-only row.
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The event this message was derived from, e.g. 'case_event:42' or 'round_event:7'.
  event_ref  TEXT NOT NULL CHECK (length(trim(event_ref)) > 0),
  phone      TEXT NOT NULL CHECK (length(trim(phone)) > 0),
  language   TEXT NOT NULL CHECK (language IN ('sw', 'en')),
  template   TEXT NOT NULL CHECK (length(trim(template)) > 0),
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 160),
  case_id    TEXT REFERENCES cases(id),
  round_id   TEXT REFERENCES rounds(id),
  at         TEXT NOT NULL
);

-- One message per event per recipient: this is what makes dispatch idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS messages_once_per_event ON messages(event_ref, phone);

CREATE TABLE IF NOT EXISTS message_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES messages(id),
  outcome     TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
  provider_ref TEXT,
  error       TEXT,
  at          TEXT NOT NULL,
  CHECK ((outcome = 'failed') = (error IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS message_attempts_by_message ON message_attempts(message_id);

CREATE TRIGGER IF NOT EXISTS messages_no_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

CREATE TRIGGER IF NOT EXISTS message_attempts_no_update BEFORE UPDATE ON message_attempts
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS message_attempts_no_delete BEFORE DELETE ON message_attempts
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

-- INSERT OR REPLACE deletes the conflicting row before inserting. SQLite fires delete triggers for
-- that only when a connection sets `PRAGMA recursive_triggers = ON`, which a plain connection (the
-- sqlite3 CLI, a script) does not. These BEFORE INSERT guards run first on every connection and
-- refuse any insert that would collide with an existing row, so REPLACE cannot rewrite history
-- whoever opens the file.
CREATE TRIGGER IF NOT EXISTS cases_no_replace BEFORE INSERT ON cases
WHEN EXISTS (SELECT 1 FROM cases WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS cases_supersede_once BEFORE INSERT ON cases
WHEN NEW.supersedes_case_id IS NOT NULL AND EXISTS (SELECT 1 FROM cases WHERE supersedes_case_id = NEW.supersedes_case_id)
BEGIN SELECT RAISE(ABORT, 'already superseded'); END;
CREATE TRIGGER IF NOT EXISTS cases_one_application BEFORE INSERT ON cases
WHEN NEW.supersedes_case_id IS NULL AND EXISTS (
  SELECT 1 FROM cases WHERE round_id = NEW.round_id AND child_id = NEW.child_id AND supersedes_case_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'duplicate application'); END;

CREATE TRIGGER IF NOT EXISTS evidence_no_replace BEFORE INSERT ON evidence
WHEN EXISTS (SELECT 1 FROM evidence WHERE id = NEW.id OR case_id = NEW.case_id)
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

CREATE TRIGGER IF NOT EXISTS rounds_no_replace BEFORE INSERT ON rounds
WHEN EXISTS (SELECT 1 FROM rounds WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

CREATE TRIGGER IF NOT EXISTS round_events_no_replace BEFORE INSERT ON round_events
WHEN EXISTS (SELECT 1 FROM round_events WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

CREATE TRIGGER IF NOT EXISTS case_events_no_replace BEFORE INSERT ON case_events
WHEN EXISTS (SELECT 1 FROM case_events WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

CREATE TRIGGER IF NOT EXISTS verification_requests_no_replace BEFORE INSERT ON verification_requests
WHEN EXISTS (SELECT 1 FROM verification_requests WHERE id = NEW.id)
  OR (NEW.child_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM verification_requests
    WHERE phone = NEW.phone AND reason = NEW.reason AND child_id = NEW.child_id AND round_id IS NEW.round_id))
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

-- A duplicate message is silently skipped rather than refused: dispatch relies on inserting
-- the same (event, phone) twice being a no-op, and RAISE(IGNORE) also turns REPLACE into one.
CREATE TRIGGER IF NOT EXISTS messages_no_replace BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM messages WHERE id = NEW.id OR (event_ref = NEW.event_ref AND phone = NEW.phone))
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER IF NOT EXISTS message_attempts_no_replace BEFORE INSERT ON message_attempts
WHEN EXISTS (SELECT 1 FROM message_attempts WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

-- The role map, enforced by the database for every connection — a plain sqlite3 session cannot
-- record a stage under the wrong role, or as someone who is not registered. (The store checks the
-- same rules first and logs refusals; these guards are the backstop for anyone who bypasses it.)
CREATE TRIGGER IF NOT EXISTS case_events_role_map BEFORE INSERT ON case_events
WHEN NOT (
  (NEW.stage = 'applied' AND (
     (NEW.actor_role = 'parent' AND EXISTS (SELECT 1 FROM households WHERE id = NEW.actor_id)) OR
     (NEW.actor_role IN ('clerk', 'chv', 'teacher') AND EXISTS (SELECT 1 FROM staff WHERE id = NEW.actor_id AND role = NEW.actor_role))))
  OR (NEW.stage = 'verified' AND NEW.actor_role IN ('chv', 'teacher')
      AND EXISTS (SELECT 1 FROM staff WHERE id = NEW.actor_id AND role = NEW.actor_role))
  OR (NEW.stage IN ('rejected', 'approved') AND NEW.actor_role = 'committee'
      AND EXISTS (SELECT 1 FROM staff WHERE id = NEW.actor_id AND role = 'committee'))
  OR (NEW.stage = 'disbursed' AND NEW.actor_role = 'clerk'
      AND EXISTS (SELECT 1 FROM staff WHERE id = NEW.actor_id AND role = 'clerk'))
  OR (NEW.stage = 'school_confirmed' AND NEW.actor_role = 'school' AND EXISTS (
      SELECT 1 FROM staff s JOIN cases c ON c.id = NEW.case_id JOIN children ch ON ch.id = c.child_id
      WHERE s.id = NEW.actor_id AND s.role = 'school' AND s.school_id = ch.school_id))
)
BEGIN SELECT RAISE(ABORT, 'role not permitted'); END;

-- An award can never take a round past its budget, whoever writes it.
CREATE TRIGGER IF NOT EXISTS case_events_within_budget BEFORE INSERT ON case_events
WHEN NEW.stage = 'approved' AND (
  SELECT COALESCE(SUM(e.amount), 0) FROM case_events e JOIN cases c ON c.id = e.case_id
  WHERE e.stage = 'approved' AND c.round_id = (SELECT round_id FROM cases WHERE id = NEW.case_id)
) + NEW.amount > (SELECT r.budget FROM rounds r JOIN cases c ON c.round_id = r.id WHERE c.id = NEW.case_id)
BEGIN SELECT RAISE(ABORT, 'over budget'); END;

CREATE TRIGGER IF NOT EXISTS round_events_role_map BEFORE INSERT ON round_events
WHEN NOT (NEW.actor_role = 'clerk' AND EXISTS (SELECT 1 FROM staff WHERE id = NEW.actor_id AND role = 'clerk'))
BEGIN SELECT RAISE(ABORT, 'role not permitted'); END;

CREATE TRIGGER IF NOT EXISTS rounds_role_map BEFORE INSERT ON rounds
WHEN NOT EXISTS (SELECT 1 FROM staff WHERE id = NEW.actor_id AND role = 'clerk')
BEGIN SELECT RAISE(ABORT, 'role not permitted'); END;

CREATE TRIGGER IF NOT EXISTS cases_no_update BEFORE UPDATE ON cases
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS cases_no_delete BEFORE DELETE ON cases
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

CREATE TRIGGER IF NOT EXISTS rounds_no_update BEFORE UPDATE ON rounds
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS rounds_no_delete BEFORE DELETE ON rounds
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

CREATE TRIGGER IF NOT EXISTS round_events_no_update BEFORE UPDATE ON round_events
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS round_events_no_delete BEFORE DELETE ON round_events
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

CREATE TRIGGER IF NOT EXISTS case_events_no_update BEFORE UPDATE ON case_events
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
CREATE TRIGGER IF NOT EXISTS case_events_no_delete BEFORE DELETE ON case_events
BEGIN SELECT RAISE(ABORT, 'immutable record'); END;

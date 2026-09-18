-- Zamu schema. Cases, evidence, rounds, and every state change are append-only:
-- triggers below reject UPDATE and DELETE, and `PRAGMA recursive_triggers = ON`
-- (see connection.ts) makes INSERT OR REPLACE fire them too.
--
-- Scope of the guarantee: this stops the application - and anything else opening the file
-- the same way - from rewriting history. It is not tamper-proofing against someone with
-- write access to the file, who can DROP TRIGGER or use PRAGMA writable_schema.
-- Detecting that needs a hash chain over events (out of scope for this story).

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

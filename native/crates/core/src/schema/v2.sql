-- This migration is executed inside the same IMMEDIATE transaction as user_version.
CREATE TABLE IF NOT EXISTS run_controls (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  cancel_requested_at TEXT,
  acceptance_binding TEXT,
  accepted_at TEXT,
  CHECK((acceptance_binding IS NULL AND accepted_at IS NULL) OR
        (length(acceptance_binding)=64 AND accepted_at IS NOT NULL)),
  CHECK(cancel_requested=0 OR acceptance_binding IS NULL)
);
INSERT OR IGNORE INTO run_controls(run_id) SELECT id FROM runs;
CREATE TRIGGER IF NOT EXISTS runs_spec_immutable BEFORE UPDATE OF id,spec,created ON runs
WHEN NEW.id<>OLD.id OR NEW.spec<>OLD.spec OR NEW.created<>OLD.created
BEGIN SELECT RAISE(ABORT,'RUN_SPEC_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS runs_terminal_fence BEFORE UPDATE OF state ON runs
WHEN OLD.state<>'running' AND NEW.state<>OLD.state
BEGIN SELECT RAISE(ABORT,'TERMINAL_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS runs_cancel_fence BEFORE UPDATE OF state ON runs
WHEN NEW.state='review' AND EXISTS(SELECT 1 FROM run_controls WHERE run_id=NEW.id AND cancel_requested=1)
BEGIN SELECT RAISE(ABORT,'CANCEL_FENCE'); END;
CREATE TRIGGER IF NOT EXISTS runs_accepted_fence BEFORE UPDATE OF payload ON runs
WHEN NEW.payload<>OLD.payload AND EXISTS(SELECT 1 FROM run_controls WHERE run_id=NEW.id AND acceptance_binding IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'ACCEPTED_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS controls_cancel_monotonic BEFORE UPDATE OF cancel_requested ON run_controls
WHEN OLD.cancel_requested=1 AND NEW.cancel_requested=0
BEGIN SELECT RAISE(ABORT,'CANCEL_IRREVERSIBLE'); END;
CREATE TRIGGER IF NOT EXISTS controls_acceptance_immutable BEFORE UPDATE OF acceptance_binding,accepted_at ON run_controls
WHEN OLD.acceptance_binding IS NOT NULL AND
 (NEW.acceptance_binding IS NOT OLD.acceptance_binding OR NEW.accepted_at IS NOT OLD.accepted_at)
BEGIN SELECT RAISE(ABORT,'ACCEPTANCE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS commands_no_rewrite BEFORE UPDATE ON commands
BEGIN SELECT RAISE(ABORT,'COMMAND_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS commands_no_delete BEFORE DELETE ON commands
BEGIN SELECT RAISE(ABORT,'COMMAND_HISTORY_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS events_no_rewrite BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT,'EVENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT,'EVENT_HISTORY_REQUIRED'); END;

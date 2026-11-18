-- Codex Direct is a separate execution profile; built-in runs are unchanged.
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
 goal_revision INTEGER NOT NULL CHECK(goal_revision>0), original TEXT NOT NULL,
 binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
 progress_json TEXT NOT NULL CHECK(json_valid(progress_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_goal_revisions (
 task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL,
 original TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,revision)
);
CREATE TABLE IF NOT EXISTS executor_sessions (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 external_thread_id TEXT, last_known_turn_id TEXT,
 profile_kind TEXT NOT NULL CHECK(profile_kind='codex-direct'),
 generation TEXT NOT NULL, status TEXT NOT NULL,
 pruned_through INTEGER NOT NULL DEFAULT 0,
 event_count INTEGER NOT NULL DEFAULT 0 CHECK(event_count>=0),
 event_bytes INTEGER NOT NULL DEFAULT 0 CHECK(event_bytes>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(id,task_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_binding_per_external_thread
 ON executor_sessions(external_thread_id) WHERE external_thread_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS external_commands (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
 goal_revision INTEGER NOT NULL, generation TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('thread/start','thread/resume','turn/start','turn/steer','turn/interrupt')),
 params_json TEXT NOT NULL CHECK(json_valid(params_json)), fingerprint TEXT NOT NULL,
 expected_thread_id TEXT, expected_turn_id TEXT, marker TEXT, exact_input TEXT,
 state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','in_flight','confirmed','unverified_outcome','unknown_needs_user_decision','rejected')),
 revision INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts IN (0,1)),
 remote_id TEXT, reason TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(session_id,task_id) REFERENCES executor_sessions(id,task_id)
);
CREATE TABLE IF NOT EXISTS session_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES executor_sessions(id),
 generation TEXT NOT NULL, at TEXT NOT NULL, origin TEXT NOT NULL,
 frame_json TEXT NOT NULL CHECK(json_valid(frame_json)), truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS session_event_cursor ON session_events(session_id,sequence);
CREATE TRIGGER IF NOT EXISTS external_intent_immutable BEFORE UPDATE ON external_commands
WHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.task_id IS NOT OLD.task_id
 OR NEW.goal_revision IS NOT OLD.goal_revision OR NEW.generation IS NOT OLD.generation
 OR NEW.method IS NOT OLD.method OR NEW.params_json IS NOT OLD.params_json OR NEW.fingerprint IS NOT OLD.fingerprint
 OR NEW.expected_thread_id IS NOT OLD.expected_thread_id OR NEW.expected_turn_id IS NOT OLD.expected_turn_id
 OR NEW.marker IS NOT OLD.marker OR NEW.exact_input IS NOT OLD.exact_input
BEGIN SELECT RAISE(ABORT,'external intent is immutable'); END;
CREATE TRIGGER IF NOT EXISTS external_state_fence BEFORE UPDATE ON external_commands
WHEN NOT (
 (OLD.state='prepared' AND NEW.state IN ('in_flight','rejected') AND NEW.attempts=CASE WHEN NEW.state='in_flight' THEN 1 ELSE 0 END)
 OR (OLD.state='in_flight' AND NEW.state IN ('confirmed','unverified_outcome','rejected') AND NEW.attempts=1)
 OR (OLD.state IN ('unverified_outcome','unknown_needs_user_decision') AND NEW.state IN ('confirmed','unknown_needs_user_decision') AND NEW.attempts=1)
) OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT,'unsafe external command transition'); END;
CREATE TRIGGER IF NOT EXISTS goal_history_immutable BEFORE UPDATE ON task_goal_revisions
BEGIN SELECT RAISE(ABORT,'goal history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS goal_history_keep BEFORE DELETE ON task_goal_revisions
BEGIN SELECT RAISE(ABORT,'goal history requires explicit archival'); END;
-- An explicit local cancellation can fence even a request still in the UI -> host channel.
-- This never resolves an in-flight remote effect; those must be reconciled.
CREATE TABLE IF NOT EXISTS external_command_tombstones (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS external_abandoned_before_dispatch BEFORE INSERT ON external_commands
WHEN EXISTS(SELECT 1 FROM external_command_tombstones WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'command was cancelled before dispatch'); END;

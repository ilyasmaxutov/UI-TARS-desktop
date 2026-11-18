-- One append-only checkpoint stream in the existing TaskStore database.
-- Raw outputs remain in the existing economy artifact store, not duplicated here.
CREATE TABLE IF NOT EXISTS task_research_checkpoints (
 task_id TEXT NOT NULL,
 investigation_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 goal_revision INTEGER NOT NULL CHECK(goal_revision>0),
 plan_version INTEGER NOT NULL CHECK(plan_version>0),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=524288),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,investigation_id,sequence),
 FOREIGN KEY(task_id,goal_revision) REFERENCES task_goal_revisions(task_id,revision)
);
CREATE TRIGGER IF NOT EXISTS research_checkpoint_identity BEFORE INSERT ON task_research_checkpoints
WHEN json_extract(NEW.payload_json,'$.plan.taskId') IS NOT NEW.task_id
 OR json_extract(NEW.payload_json,'$.plan.investigationId') IS NOT NEW.investigation_id
 OR json_extract(NEW.payload_json,'$.sequence') IS NOT NEW.sequence
 OR json_extract(NEW.payload_json,'$.schema') IS NOT 1
 OR json_extract(NEW.payload_json,'$.plan.goalRevision') IS NOT NEW.goal_revision
 OR json_extract(NEW.payload_json,'$.plan.planVersion') IS NOT NEW.plan_version
 OR json_extract(NEW.payload_json,'$.plan.originalGoal') IS NOT
  (SELECT original FROM task_goal_revisions WHERE task_id=NEW.task_id AND revision=NEW.goal_revision)
BEGIN SELECT RAISE(ABORT,'research checkpoint identity or original goal differs'); END;
CREATE TRIGGER IF NOT EXISTS research_checkpoint_sequence BEFORE INSERT ON task_research_checkpoints
WHEN NEW.sequence <> COALESCE((SELECT MAX(sequence)+1 FROM task_research_checkpoints
 WHERE task_id=NEW.task_id AND investigation_id=NEW.investigation_id),1)
 OR NEW.plan_version < COALESCE((SELECT MAX(plan_version) FROM task_research_checkpoints
 WHERE task_id=NEW.task_id AND investigation_id=NEW.investigation_id),1)
BEGIN SELECT RAISE(ABORT,'research checkpoint conflict or plan rollback'); END;
CREATE TRIGGER IF NOT EXISTS research_checkpoint_immutable BEFORE UPDATE ON task_research_checkpoints
BEGIN SELECT RAISE(ABORT,'research checkpoint is immutable'); END;
CREATE TRIGGER IF NOT EXISTS research_checkpoint_keep BEFORE DELETE ON task_research_checkpoints
BEGIN SELECT RAISE(ABORT,'research history requires explicit archival'); END;

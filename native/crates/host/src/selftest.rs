//! Offline self-test for the compiled host, not a provider or GUI smoke test.
//! It uses a fresh temporary directory and never reads LOCALAPPDATA or CODEX_HOME.
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use studio_core::{model::*, store::Store};

struct TemporaryRoot(PathBuf);
impl Drop for TemporaryRoot {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}
pub fn run() -> Result<Value> {
    let temp = TemporaryRoot(std::env::temp_dir().join(new_id("studio_host_selftest")));
    fs::create_dir(&temp.0)?;
    let project = temp.0.join("project");
    fs::create_dir(&project)?;
    let source = project.join("keep.txt");
    fs::write(&source, "unchanged UTF-8 source: исходник\n")?;
    let root = temp.0.join("state");
    let task_id = "selftest_task";
    let session_id = "selftest_session";
    let command_id = "selftest_command";
    {
        let store = Store::open(&root)?;
        store.create_task(&json!({"id":task_id,"projectId":"selftest_project","title":"Offline self-test", "original":"Read-only fixture; no model", "binding":{"kind":"mounted","id":"selftest_binding","rootPath":project,"access":"read-only"}}))?;
        store.new_executor_session(task_id, session_id, Some("fixture_thread"))?;
        store.set_session_generation(session_id, "fixture_generation")?;
        store.observe_thread_snapshot(session_id, "fixture_generation", &json!({"id":"fixture_thread","status":{"type":"idle"},"turns":[]}))?;
        store.prepare_external(command_id, session_id, 1, "turn/start", &json!({"threadId":"fixture_thread","input":[{"type":"text","text":"fixture only"}]}), None, None)?;
        ensure(store.begin_external_dispatch(command_id)?, "SELFTEST", "Failed to reserve fixture send")?;
        // This models only the local send fence. No bytes are sent to any provider.
    }
    let store = Store::open(&root)?;
    store.recover_executor_sessions()?;
    let command = store.external_command(command_id)?;
    ensure(command["state"] == "unverified_outcome", "SELFTEST", "Restart lost unknown outcome")?;
    ensure(!store.begin_external_dispatch(command_id)?, "SELFTEST", "Restart permitted duplicate send")?;
    ensure(store.task(task_id)?["original"] == "Read-only fixture; no model", "SELFTEST", "Goal changed")?;
    ensure(fs::read_to_string(&source)? == "unchanged UTF-8 source: исходник\n", "SELFTEST", "Source changed")?;
    drop(store);
    Ok(json!({"schema":1,"status":"passed","platform":std::env::consts::OS,"storeReopened":true,"unknownPreserved":true,"repeatDispatchPermitted":false,"sourceUnchanged":true,"providerRequests":0,"ipcTested":false,"guiExecuted":false,"containmentAccepted":false}))
}

use super::*;
use crate::codex::Director;
use std::{path::PathBuf, time::Instant};

struct Fixture {
    root: PathBuf,
    store: Arc<Store>,
    peer: Arc<Peer>,
}

impl Fixture {
    fn new(mode: &str) -> Self {
        let root = std::env::temp_dir().join(new_id("studio_transport_test"));
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        let executable = root.join(if cfg!(windows) { "mock-codex.exe" } else { "mock-codex" });
        let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        let compiled = Command::new(compiler)
            .arg("--edition=2024")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/mock_codex.rs"))
            .arg("-o").arg(&executable).output().expect("Rust compiler is required for the native stdio fixture");
        assert!(compiled.status.success(), "native fixture compilation failed: {}", String::from_utf8_lossy(&compiled.stderr));
        let store = Arc::new(Store::open(&root.join("state")).unwrap());
        store.create_task(&json!({
            "id":"task", "projectId":"project", "title":"Transport test", "original":"Сохранить исходную цель",
            "binding":{"kind":"mounted","id":"binding","rootPath":root.join("workspace"),"access":"read-only"}
        })).unwrap();
        store.new_executor_session("task", "session", Some("thread")).unwrap();
        let mut command = Command::new(executable);
        command.arg(mode).arg(root.join("wire.jsonl")).current_dir(root.join("workspace"));
        let peer = Peer::spawn_for_test(command, "session", store.clone()).unwrap();
        store.observe_thread_snapshot("session", &peer.generation, &json!({"id":"thread","status":{"type":"idle"},"turns":[]})).unwrap();
        Self { root, store, peer }
    }

    fn prepare(&self) -> Value {
        let (marker, exact) = protocol::marked_input("command", "Сохранить исходную цель").unwrap();
        self.store.prepare_external("command", "session", 1, "turn/start",
            &json!({"threadId":"thread","input":[{"type":"text","text":exact}]}), Some(&marker), Some(&exact)).unwrap()
    }

    fn sent_turns(&self) -> usize {
        std::fs::read_to_string(self.root.join("wire.jsonl")).unwrap().lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|frame| frame["method"] == "turn/start").count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.peer.close();
        // Windows may hold the executable/diagnostic for a short time while the
        // reader threads observe EOF. The whole private fixture is disposable.
        // SQLite is still open here, so cleanup continues after both Arc owners
        // are gone through the explicit finish helper below.
    }
}

fn finish(fixture: Fixture) {
    fixture.peer.close();
    let root = fixture.root.clone();
    drop(fixture);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match std::fs::remove_dir_all(&root) {
            Ok(()) => return,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => panic!("cannot remove native fixture {}: {error}", root.display()),
        }
    }
}

#[test]
fn native_pipe_preserves_fragmented_utf8_frames() {
    let fixture = Fixture::new("split");
    let value = fixture.peer.call("thread/read", json!({"threadId":"thread"})).unwrap();
    assert_eq!(value["thread"]["preview"], "ответ по частям");
    assert_eq!(fixture.sent_turns(), 0);
    finish(fixture);
}

#[test]
fn late_ack_confirms_the_original_command_without_a_resend() {
    let fixture = Fixture::new("late_ack");
    let command = fixture.prepare();
    assert!(fixture.store.begin_external_dispatch("command").unwrap());
    let error = fixture.peer.call_frame_timeout(
        json!({"id":"delayed_rpc","method":command["method"],"params":command["params"]}),
        Some("command".into()), Duration::from_millis(30)).unwrap_err();
    assert_eq!(error.code, "RPC_TIMEOUT");
    fixture.store.finish_external("command", "unverified_outcome", None, None, "test_timeout").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let current = fixture.store.external_command("command").unwrap();
        if current["state"] == "confirmed" {
            assert_eq!(current["remoteId"], "remote_turn");
            assert_eq!(current["attempts"], 1);
            break;
        }
        assert!(Instant::now() < deadline, "late ACK was lost: {current}");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!fixture.store.begin_external_dispatch("command").unwrap());
    assert_eq!(fixture.sent_turns(), 1);
    finish(fixture);
}

#[test]
fn native_exit_after_dispatch_keeps_unknown_outcome_and_no_replay() {
    let fixture = Fixture::new("exit");
    let director = Director::new(fixture.store.clone());
    let command = fixture.prepare();
    let uncertain = director.send_once(&fixture.peer, command).unwrap();
    assert_eq!(uncertain["state"], "unverified_outcome");
    assert_eq!(uncertain["attempts"], 1);
    assert!(!fixture.peer.alive.load(Ordering::SeqCst));
    let same = director.send_once(&fixture.peer, uncertain).unwrap();
    assert_eq!(same["state"], "unverified_outcome");
    assert_eq!(fixture.sent_turns(), 1);
    fixture.store.recover_executor_sessions().unwrap();
    assert!(!fixture.store.begin_external_dispatch("command").unwrap());
    drop(director);
    finish(fixture);
}

#[test]
fn completion_before_ack_stays_idle_over_real_transport() {
    let fixture = Fixture::new("complete_before_ack");
    let director = Director::new(fixture.store.clone());
    let confirmed = director.send_once(&fixture.peer, fixture.prepare()).unwrap();
    assert_eq!(confirmed["state"], "confirmed");
    assert_eq!(fixture.store.executor_session("session").unwrap()["status"], "idle");
    let events = fixture.store.session_events("session", 0).unwrap();
    assert_eq!(events["events"].as_array().unwrap().len(), 2);
    assert_eq!(fixture.sent_turns(), 1);
    drop(director);
    finish(fixture);
}

#[test]
fn reconcile_new_unmaterialized_thread_keeps_the_connected_empty_view() {
    let fixture = Fixture::new("unmaterialized");
    let director = Director::new(fixture.store.clone());
    director.peers.lock().unwrap().insert("session".into(), fixture.peer.clone());
    let readback = director.reconcile("session").unwrap();
    assert_eq!(readback["session"]["status"], "idle");
    assert_eq!(readback["history"]["data"], json!([]));
    assert_eq!(readback["history"]["historyAvailable"], false);
    assert_eq!(readback["history"]["coverage"], "unmaterialized-before-first-user-message");
    assert_eq!(readback["history"]["absenceOfUncertainCommandProven"], false);
    assert_eq!(fixture.sent_turns(), 0);
    drop(director);
    finish(fixture);
}

#[test]
fn unmaterialized_readback_neither_resolves_nor_replays_uncertain_commands() {
    let fixture = Fixture::new("unmaterialized");
    let director = Director::new(fixture.store.clone());
    director.peers.lock().unwrap().insert("session".into(), fixture.peer.clone());
    fixture.prepare();
    assert!(fixture.store.begin_external_dispatch("command").unwrap());
    fixture.store.finish_external("command", "unverified_outcome", None, None, "lost_turn_ack").unwrap();
    fixture.store.prepare_external("resume", "session", 1, "thread/resume",
        &json!({"threadId":"thread","excludeTurns":true}), None, None).unwrap();
    assert!(fixture.store.begin_external_dispatch("resume").unwrap());
    fixture.store.finish_external("resume", "unverified_outcome", None, None, "lost_resume_ack").unwrap();
    let readback = director.reconcile("session").unwrap();
    for command in readback["commands"].as_array().unwrap() {
        assert_eq!(command["state"], "unknown_needs_user_decision");
        assert_eq!(command["attempts"], 1);
        assert!(command["remoteId"].is_null());
        assert!(!fixture.store.begin_external_dispatch(command["id"].as_str().unwrap()).unwrap());
    }
    let wire = std::fs::read_to_string(fixture.root.join("wire.jsonl")).unwrap();
    assert!(!wire.contains("turn/start"));
    assert!(!wire.contains("thread/resume"));
    drop(director);
    finish(fixture);
}

#[test]
fn unrelated_history_rpc_error_is_not_an_empty_thread() {
    let fixture = Fixture::new("history_error");
    let director = Director::new(fixture.store.clone());
    director.peers.lock().unwrap().insert("session".into(), fixture.peer.clone());
    let error = director.reconcile("session").unwrap_err();
    assert_eq!(error.code, "CODEX_RPC_INVALID_REQUEST");
    assert_eq!(error.message, "History backend is unavailable");
    assert_eq!(fixture.sent_turns(), 0);
    drop(director);
    finish(fixture);
}

#[test]
fn unmaterialized_error_cannot_erase_a_previously_acknowledged_turn() {
    let fixture = Fixture::new("unmaterialized");
    let director = Director::new(fixture.store.clone());
    director.peers.lock().unwrap().insert("session".into(), fixture.peer.clone());
    fixture.prepare();
    assert!(fixture.store.begin_external_dispatch("command").unwrap());
    fixture.store.finish_external("command", "confirmed", Some("known_turn"),
        Some(&json!({"turn":{"id":"known_turn","status":"inProgress"}})), "observed_ack").unwrap();
    assert!(director.reconcile("session").is_err());
    assert_eq!(fixture.store.executor_session("session").unwrap()["status"], "running");
    assert_eq!(fixture.store.executor_session("session").unwrap()["lastKnownTurnId"], "known_turn");
    assert_eq!(fixture.sent_turns(), 0);
    drop(director);
    finish(fixture);
}

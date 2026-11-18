//! Native acceptance-contract tests. Source only until cargo executes on the pinned profile.
use studio_core::{engine, files, model::*, review, store::Store};
use std::{path::PathBuf, sync::atomic::AtomicBool};
use serde_json::{json, Value};

struct TempRoot(PathBuf);
impl TempRoot { fn new() -> Self { Self(std::env::temp_dir().join(new_id("studio-v02-test"))) } }
impl Drop for TempRoot { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
fn fixture() -> (Document, Vec<FileData>) {
    (serde_json::from_str(include_str!("../../../../fixtures/report-document.json")).unwrap(),
     serde_json::from_str(include_str!("../../../../fixtures/report-input.json")).unwrap())
}
fn ready(store: &Store, command: &str) -> Run {
    let (doc, inputs) = fixture();
    let (run, fresh) = store.reserve_run(command, &doc, &inputs).unwrap(); assert!(fresh);
    let result = engine::execute(&doc, &inputs, run, &AtomicBool::new(false), |r|store.save_run(r)).unwrap();
    assert_eq!(result.state, "review"); result
}
#[test] fn durable_command_can_be_found_after_reopening_store() {
    let root=TempRoot::new(); let id;
    { let store=Store::open(&root.0).unwrap(); let (d,f)=fixture(); id=store.reserve_run("lost-reply",&d,&f).unwrap().0.id; }
    { let store=Store::open(&root.0).unwrap(); assert_eq!(store.command_run("lost-reply").unwrap().unwrap().id,id); assert!(store.command_run("absent").unwrap().is_none()); }
}
#[test] fn original_encoded_request_bytes_define_deduplication_identity() {
    let root=TempRoot::new(); let store=Store::open(&root.0).unwrap(); let (d,f)=fixture();
    let compact=serde_json::to_string(&json!({"document":d,"files":f})).unwrap();
    let pretty=serde_json::to_string_pretty(&serde_json::from_str::<Value>(&compact).unwrap()).unwrap();
    let (a,fresh)=store.reserve_encoded("encoded",&compact).unwrap();assert!(fresh);
    assert_eq!(a.command_fingerprint.as_deref(),Some(files::hash(compact.as_bytes()).as_str()));
    let (b,fresh)=store.reserve_encoded("encoded",&compact).unwrap();assert!(!fresh);assert_eq!(a.id,b.id);
    assert_eq!(store.reserve_encoded("encoded",&pretty).unwrap_err().code,"ID_CONFLICT");
}
#[test] fn cancellation_is_persistent_but_not_a_claim_that_work_stopped() {
    let root=TempRoot::new();let id;
    { let store=Store::open(&root.0).unwrap();let(d,f)=fixture();id=store.reserve_run("cancel",&d,&f).unwrap().0.id;
      let receipt=store.request_cancel(&id).unwrap();assert!(receipt.cancel_requested);assert_eq!(receipt.state,"running"); }
    { let store=Store::open(&root.0).unwrap();assert!(store.cancelled(&id).unwrap());assert_eq!(store.recover().unwrap(),1);
      let run=store.get_run(&id).unwrap();assert_eq!(run.state,"cancelled");assert!(!run.accepted);assert_eq!(store.recover().unwrap(),0); }
}
#[test] fn durable_cancel_fences_late_completed_checkpoint() {
    let root=TempRoot::new();let store=Store::open(&root.0).unwrap();let(d,f)=fixture();let(run,_)=store.reserve_run("cancel-late",&d,&f).unwrap();
    let finished=engine::execute(&d,&f,run.clone(),&AtomicBool::new(false),|_|Ok(())).unwrap();
    store.request_cancel(&run.id).unwrap();assert_eq!(store.save_run(&finished).unwrap_err().code,"CANCELLED");
}
#[test] fn terminal_run_cannot_be_reset_by_a_late_worker() {
    let root=TempRoot::new();let store=Store::open(&root.0).unwrap();let run=ready(&store,"terminal");
    let mut stale=run.clone();stale.state="running".into();assert_eq!(store.save_run(&stale).unwrap_err().code,"TERMINAL_IMMUTABLE");
    assert_eq!(store.get_run(&run.id).unwrap().state,"review");
}
#[test] fn acceptance_requires_the_exact_result_shown_to_owner() {
    let root=TempRoot::new();let store=Store::open(&root.0).unwrap();let run=ready(&store,"owner");
    assert_eq!(store.accept(&run.id,&"0".repeat(64)).unwrap_err().code,"STALE_RESULT");
    let binding=review::binding(&run).unwrap();let first=store.accept(&run.id,&binding).unwrap();let second=store.accept(&run.id,&binding).unwrap();
    assert!(first.accepted);assert_eq!(serde_json::to_value(first.acceptance).unwrap(),serde_json::to_value(second.acceptance).unwrap());
}
#[test] fn acceptance_and_receipt_survive_reopening_database() {
    let root=TempRoot::new();let id;let binding;
    { let store=Store::open(&root.0).unwrap();let run=ready(&store,"accepted");id=run.id.clone();binding=review::binding(&run).unwrap();store.accept(&id,&binding).unwrap(); }
    { let store=Store::open(&root.0).unwrap();assert_eq!(store.recover().unwrap(),0);let r=store.accepted_run(&id,&binding).unwrap();assert_eq!(r.acceptance.unwrap().binding_hash,binding); }
}
#[test] fn accepted_artifact_is_reread_before_export_admission() {
    let root=TempRoot::new();let store=Store::open(&root.0).unwrap();let run=ready(&store,"tamper");let binding=review::binding(&run).unwrap();store.accept(&run.id,&binding).unwrap();
    let mut artifact=run.artifacts[0].clone();artifact.files[0].content="forged result".into();
    std::fs::write(root.0.join("artifacts").join(format!("{}.json",artifact.hash)),serde_json::to_vec(&artifact).unwrap()).unwrap();
    assert!(store.accepted_run(&run.id,&binding).is_err());
}
#[test] fn omitted_node_does_not_pass_full_result_inspection() {
    let root=TempRoot::new();let store=Store::open(&root.0).unwrap();let mut run=ready(&store,"omitted");let(d,f)=fixture();
    let id=run.nodes.keys().next().unwrap().clone();run.nodes.remove(&id);assert_eq!(review::inspect(&run,&d,&f).unwrap_err().code,"INCOMPLETE");
}
#[test] fn unrelated_run_can_complete_after_first_run_requests_cancel() {
    let root=TempRoot::new();let store=Store::open(&root.0).unwrap();let(d,f)=fixture();let(a,_)=store.reserve_run("a",&d,&f).unwrap();store.request_cancel(&a.id).unwrap();
    let b=ready(&store,"b");assert_eq!(b.state,"review");assert!(!store.cancelled(&b.id).unwrap());
}
#[test] fn typescript_binding_fixture_matches_rust_binding_function() {
    let fixture:Value=serde_json::from_str(include_str!("../../../../fixtures/review-binding.json")).unwrap();
    let run:Run=serde_json::from_value(fixture["run"].clone()).unwrap();
    assert_eq!(review::binding(&run).unwrap(),fixture["bindingHash"].as_str().unwrap());
    assert_eq!(files::hash(fixture["specJson"].as_str().unwrap().as_bytes()),run.command_fingerprint.unwrap());
}
#[test] fn worker_cannot_write_an_acceptance_receipt() {
    let root=TempRoot::new();let store=Store::open(&root.0).unwrap();let(d,f)=fixture();let(mut run,_)=store.reserve_run("worker",&d,&f).unwrap();
    run.accepted=true;assert_eq!(store.save_run(&run).unwrap_err().code,"WORKER_ACCEPTANCE");
}

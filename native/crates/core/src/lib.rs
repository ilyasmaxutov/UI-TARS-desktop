//! Native built-in operations and durable state. Not an arbitrary-code sandbox.
pub mod model;
pub mod graph;
pub mod files;
pub mod engine;
pub mod store;
pub mod review;
pub mod task_store;
pub mod research_store;

#[cfg(test)]
mod tests {
    use super::*;
    use model::*;
    use std::sync::atomic::AtomicBool;
    fn fixture()->Document {serde_json::from_str(include_str!("../../../../fixtures/report-document.json")).unwrap()}
    #[test] fn typescript_golden_artifact_matches_native(){
        let d=fixture();let input:Vec<FileData>=serde_json::from_str(include_str!("../../../../fixtures/report-input.json")).unwrap();
        let expected:Artifact=serde_json::from_str(include_str!("../../../../fixtures/report-artifact.json")).unwrap();
        let r=engine::execute(&d,&input,engine::prepare(&d,&input).unwrap(),&AtomicBool::new(false),|_|Ok(())).unwrap();
        assert_eq!(r.artifacts[0].hash,expected.hash);assert_eq!(r.artifacts[0].files,expected.files);
    }
    #[test] fn rejects_unsafe_paths(){for p in ["../x","C:/x","/x","a\\b","NUL.txt","a:stream"]{assert!(files::safe_path(p).is_err(),"{p}");}}
    #[test] fn normalization_idempotent(){let a=files::normalized("a  \r\n");assert_eq!(a,"a\n");assert_eq!(files::normalized(&a),a);}
    #[test] fn compiles_fixture(){assert!(graph::compile(&fixture()).unwrap().diagnostics.is_empty());}
    #[test] fn real_content_not_status(){let d=fixture();let input=vec![FileData{path:"x.txt".into(),content:"real source\n".into()}];let r=engine::prepare(&d,&input).unwrap();let r=engine::execute(&d,&input,r,&AtomicBool::new(false),|_|Ok(())).unwrap();assert_eq!(r.state,"review");assert!(!r.accepted);assert!(r.artifacts[0].files[0].content.contains(&files::hash(b"real source\n")));}
    #[test] fn tamper_detected(){let d=fixture();let input=vec![FileData{path:"x.txt".into(),content:"abc".into()}];let mut a=files::seal(&input,&d,vec![]).unwrap();a.files[0].content="fake".into();assert!(!files::artifact_valid(&a).unwrap());}
    #[test] fn false_criterion_fails(){let mut d=fixture();d.goal.obligations[0].value="absent marker".into();let input=vec![FileData{path:"x.txt".into(),content:"abc".into()}];let r=engine::prepare(&d,&input).unwrap();let r=engine::execute(&d,&input,r,&AtomicBool::new(false),|_|Ok(())).unwrap();assert_eq!(r.state,"failed");assert!(r.artifacts.is_empty());}
    #[test] fn no_empty_success(){let d=fixture();let r=engine::prepare(&d,&[]).unwrap();let r=engine::execute(&d,&[],r,&AtomicBool::new(false),|_|Ok(())).unwrap();assert_eq!(r.state,"failed");}
    #[test] fn cancellation_not_success(){let d=fixture();let input=vec![FileData{path:"x".into(),content:"x".into()}];let r=engine::prepare(&d,&input).unwrap();let r=engine::execute(&d,&input,r,&AtomicBool::new(true),|_|Ok(())).unwrap();assert_eq!(r.state,"cancelled");assert!(r.artifacts.is_empty());}
    #[test] fn cannot_enable_agent(){let mut d=fixture();d.nodes[1].kind="agent.codex".into();assert!(graph::compile(&d).unwrap().diagnostics.iter().any(|x|x.code=="UNAVAILABLE"));}
    #[test] fn durable_duplicate_and_restart(){let root=std::env::temp_dir().join(new_id("studio-test"));let d=fixture();let input=vec![FileData{path:"x".into(),content:"x".into()}];{
        let s=store::Store::open(&root).unwrap();let(a,new)=s.reserve_run("cmd",&d,&input).unwrap();assert!(new);let(b,new)=s.reserve_run("cmd",&d,&input).unwrap();assert!(!new);assert_eq!(a.id,b.id);
    }{let s=store::Store::open(&root).unwrap();assert_eq!(s.recover().unwrap(),1);let(r,new)=s.reserve_run("cmd",&d,&input).unwrap();assert!(!new);assert_eq!(r.state,"interrupted");}std::fs::remove_dir_all(root).unwrap();}
}

mod sql_integer;

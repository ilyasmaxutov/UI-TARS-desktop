//! Local helper integration, reusing TaskStore and the existing economy store.
//! This is not a second agent or a polling model. An MCP event only points to a
//! sealed local report; arbitrary provider text cannot author evidence directly.
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use serde_json::Value;
use studio_core::{files, model::*, store::Store, task_store::field};

fn project_state(store: &Store, task: &Value) -> Result<PathBuf> {
    let workspace = field(&task["binding"], "rootPath")?;
    let hash = files::hash(workspace.as_bytes());
    Ok(store.economy_root().join(&hash[..24]))
}
fn id(s: &str) -> bool { !s.is_empty() && s.len()<=80 && s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-') }
fn read_bytes(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let meta=fs::symlink_metadata(path)?;
    ensure(meta.is_file()&&!meta.file_type().is_symlink()&&meta.len()<=limit,"RESEARCH_FILE","Недопустимый файл отчёта")?;
    #[cfg(windows)]{use std::os::windows::fs::MetadataExt;ensure(meta.file_attributes()&0x400==0,"RESEARCH_FILE","Reparse-отчёт не разрешён")?;}
    let mut bytes=Vec::new();fs::File::open(path)?.take(limit+1).read_to_end(&mut bytes)?;
    ensure(bytes.len() as u64<=limit,"RESEARCH_LIMIT","Файл вырос сверх предела")?;
    Ok(bytes)
}
fn read_json(path: &Path, limit: u64) -> Result<Value> { Ok(serde_json::from_slice(&read_bytes(path,limit)?)?) }
/// Re-read a report from the fixed private store. No request replay, no models.
pub fn import_saved(store: &Store, task_id: &str, sweep_id: &str) -> Result<Value> {
    ensure(id(sweep_id),"RESEARCH_ID","Некорректный ID пакета")?;
    let task=store.task(task_id)?;let state=project_state(store,&task)?;
    let journal=read_json(&state.join("packets").join(format!("sweep_{sweep_id}.json")),2*1024*1024)?;
    let plan=&journal["request"]["plan"];let report=&journal["report"];
    ensure(plan["taskId"]==task_id&&report["taskId"]==task_id&&report["sweepId"]==sweep_id,"RESEARCH_ID","Пакет другой задачи")?;
    let artifact=field(report,"reportArtifact")?;
    ensure(id(artifact),"RESEARCH_ID","Недопустимый артефакт")?;
    let artifact_dir=state.join("artifacts").join(artifact);
    let canonical=fs::canonicalize(&artifact_dir)?;let store_root=fs::canonicalize(state.join("artifacts"))?;
    ensure(canonical.starts_with(&store_root),"RESEARCH_PATH","Отчёт за пределами хранилища")?;
    let manifest=read_json(&artifact_dir.join("manifest.json"),65536)?;
    let path=artifact_dir.join("data.json");let bytes=read_bytes(&path,2*1024*1024)?;
    let full:Value=serde_json::from_slice(&bytes)?;
    ensure(bytes.len()<=2*1024*1024&&manifest["id"]==artifact&&manifest["files"]["data.json"]["sha256"].as_str()==Some(files::hash(&bytes).as_str())&&report["reportSha256"]==manifest["files"]["data.json"]["sha256"],"RESEARCH_INTEGRITY","Отчёт изменён")?;
    ensure(full["request"]==journal["request"]&&full["report"]["taskId"]==task_id&&full["report"]["sweepId"]==sweep_id,"RESEARCH_INTEGRITY","Основание и отчёт разошлись")?;
    // The compact journal is a presentation, not authority for evidence/coverage.
    for key in ["schema","sweepId","investigationId","taskId","goalRevision","planVersion","state","sourceHash","sourceCoverage","evidenceRefs","unknownEffects","untestedHypotheses","nextAction","durationMs","resumed","localModelCalls","observedTokens"] {
        ensure(full["report"][key]==report[key],"RESEARCH_INTEGRITY","Сводка не совпадает с запечатанными наблюдениями")?;
    }
    let observed=full["report"]["probes"].as_array().ok_or_else(||Error::new("RESEARCH_INTEGRITY","Нет проверок"))?;
    let compact=report["probes"].as_array().ok_or_else(||Error::new("RESEARCH_INTEGRITY","Нет сводки проверок"))?;
    ensure(observed.len()==compact.len(),"RESEARCH_INTEGRITY","Проверка исчезла из сводки")?;
    for (a,b) in observed.iter().zip(compact) {for key in ["probeId","question","state","coverage","evidenceIds"] {ensure(a[key]==b[key],"RESEARCH_INTEGRITY","Состояние проверки изменено")?;}}

    let old=store.research_checkpoint(task_id,Some(field(plan,"investigationId")?))?;
    if !store.research_plan_known(plan)? {store.save_research_plan(plan,old["sequence"].as_u64().unwrap_or(0))?;}
    store.record_research_sweep(report)
}

// Collect only a bounded prefix but drain pipes so a large diagnostic cannot
// deadlock the child. No captured bytes are sent to a model by this function.
fn collect(mut input: impl Read, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut result=Vec::new();let mut buffer=[0u8;8192];
    loop {let n=input.read(&mut buffer)?;if n==0{break;}let take=n.min(cap.saturating_sub(result.len()));result.extend_from_slice(&buffer[..take]);}
    Ok(result)
}
fn helper(store:&Store,task:&Value,command:&str,input:&Value)->Result<Value>{
    let path=super::codex::economy::helper_path()?;let workspace=Path::new(field(&task["binding"],"rootPath")?);let state=project_state(store,task)?;
    fs::create_dir_all(&state)?;let requests=state.join("requests");fs::create_dir_all(&requests)?;
    let data=serde_json::to_vec(input)?;ensure(data.len()<=256*1024,"RESEARCH_LIMIT","План слишком велик")?;
    let input_path=requests.join(format!("{}.json",files::hash(&data)));
    match fs::OpenOptions::new().write(true).create_new(true).open(&input_path) {
        Ok(mut f)=>{f.write_all(&data)?;f.sync_all()?;},
        Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>{ensure(read_bytes(&input_path,256*1024)?==data,"RESEARCH_INTEGRITY","Сохранённый план изменён")?;},
        Err(e)=>return Err(e.into())
    }
    let mut cmd=Command::new(path);cmd.arg(command).arg("--project").arg(workspace).arg("--state").arg(&state).arg("--input").arg(&input_path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]{use std::os::windows::process::CommandExt;cmd.creation_flags(0x08000000);}
    let mut child=cmd.spawn()?;let stdout=child.stdout.take().ok_or_else(||Error::new("RESEARCH_PIPE","Нет stdout"))?;let stderr=child.stderr.take().ok_or_else(||Error::new("RESEARCH_PIPE","Нет stderr"))?;
    let out=std::thread::spawn(move||collect(stdout,32769));let err=std::thread::spawn(move||collect(stderr,8192));
    let start=Instant::now();let deadline=Duration::from_secs(input["limits"]["wallSeconds"].as_u64().unwrap_or(30).min(300)+15);
    let mut timed_out=false;
    let status=loop{if let Some(status)=child.try_wait()?{break status;}if start.elapsed()>deadline{timed_out=true;let _=child.kill();break child.wait()?;}std::thread::sleep(Duration::from_millis(20));};
    let output=out.join().map_err(|_|Error::new("RESEARCH_PIPE","Поток stdout прерван"))??;let error=err.join().map_err(|_|Error::new("RESEARCH_PIPE","Поток stderr прерван"))??;
    ensure(!timed_out,"RESEARCH_TIMEOUT","Диагностика прервана; сохранённые свидетельства доступны. Автоповтора нет")?;
    ensure(status.success(),"RESEARCH_HELPER",String::from_utf8_lossy(&error).to_string())?;
    ensure(output.len()<=32768,"RESEARCH_LIMIT","Ответ инструмента слишком велик")?;
    Ok(serde_json::from_slice(&output)?)
}

pub struct ResearchService { store:Arc<Store>, executing:Mutex<()> }
impl ResearchService {
    pub fn new(store:Arc<Store>)->Self{Self{store,executing:Mutex::new(())}}
    pub fn execute(&self, request:&Value, expected_sequence:u64)->Result<Value>{
        let _guard=self.executing.try_lock().map_err(|_|Error::new("RESEARCH_BUSY","Локальный пакет уже выполняется"))?;
        let plan=&request["plan"];let task=self.store.task(field(plan,"taskId")?)?;
        ensure(task["goalRevision"]==plan["goalRevision"]&&task["original"]==plan["originalGoal"],"GOAL_CONFLICT","Цель изменена")?;
        // First native bridge is pure file I/O. Fixed Git may be enabled later
        // with separately tested child-process cancellation, not by a plan flag.
        ensure(request["permissionScope"]["allowGit"]==false,"RESEARCH_PROFILE","Этот маршрут допускает только чтение файлов, без дочернего Git")?;
        helper(&self.store,&task,"sweep-preflight",request)?;
        self.store.save_research_plan(plan,expected_sequence)?;
        self.store.assert_research_admission(field(plan,"taskId")?,field(plan,"investigationId")?,plan["planVersion"].as_u64().unwrap_or(0))?;
        let report=helper(&self.store,&task,"sweep",request)?;
        import_saved(&self.store,field(plan,"taskId")?,field(&report,"sweepId")?)
    }
}

/// Recognize only this local tool's typed completion, not text mentioning it.
/// Failures are local diagnostic events; they do not start a model/repair loop.
pub fn observe_mcp(store:&Store,session_id:&str,frame:&Value)->Result<Option<Value>>{
    if frame["method"]!="item/completed" {return Ok(None);}
    let item=&frame["params"]["item"];
    if item["type"]!="mcpToolCall"||item["server"]!="studio_economy"||item["tool"]!="diagnostic_sweep"||item["status"]!="completed"{return Ok(None);}
    let session=store.executor_session(session_id)?;
    let contents=item["result"]["content"].as_array().ok_or_else(||Error::new("RESEARCH_EVENT","В событии отсутствует содержимое; требуется локальная сверка"))?;
    for content in contents {
        if content["type"]!="text" {continue;}
        let Some(text)=content["text"].as_str()else{continue;};
        ensure(text.len()<=24576,"RESEARCH_EVENT","Слишком большой результат")?;
        let report:Value=serde_json::from_str(text)?;
        ensure(report["taskId"]==session["taskId"],"RESEARCH_ID","Свидетельство другой задачи")?;
        return import_saved(store,field(&session,"taskId")?,field(&report,"sweepId")?).map(Some);
    }
    Err(Error::new("RESEARCH_EVENT","Сохранённый отчёт не найден в событии"))
}

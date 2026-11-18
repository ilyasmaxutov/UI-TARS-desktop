use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use std::{collections::HashMap,io::{Read,Write},path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}}};
use studio_core::{engine,files,model::*,store::Store};
#[cfg(windows)]pub mod windows;
pub mod codex;
pub mod research;
pub mod selftest;
pub const MAX_FRAME:usize=32*1024*1024;
#[derive(Debug,Serialize,Deserialize)]
pub struct Request {pub id:String,pub method:String,#[serde(default)]pub params:Value}
#[derive(Debug,Serialize)]
pub struct Response {pub id:String,pub result:Option<Value>,pub error:Option<Error>}
pub fn read_frame(reader:&mut impl Read)->Result<Vec<u8>>{let mut size=[0u8;4];reader.read_exact(&mut size)?;let n=u32::from_le_bytes(size)as usize;ensure(n>0&&n<=MAX_FRAME,"FRAME","Превышен размер кадра")?;let mut out=vec![0;n];reader.read_exact(&mut out)?;Ok(out)}
pub fn write_frame(writer:&mut impl Write,data:&[u8])->Result<()>{ensure(!data.is_empty()&&data.len()<=MAX_FRAME,"FRAME","Неверный размер кадра")?;writer.write_all(&(data.len()as u32).to_le_bytes())?;writer.write_all(data)?;writer.flush()?;Ok(())}
pub fn data_root()->Result<PathBuf>{
    let base=std::env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or_else(||Error::new("WINDOWS_PROFILE","LOCALAPPDATA недоступен"))?;Ok(base.join("PlatformStudio"))
}
pub struct Service {pub store:Arc<Store>,codex:codex::Director,research:research::ResearchService,cancel:Arc<Mutex<HashMap<String,Arc<AtomicBool>>>>}
impl Service {
    pub fn new(root:&Path)->Result<Self>{let store=Arc::new(Store::open(root)?);store.recover()?;store.recover_executor_sessions()?;let codex=codex::Director::new(store.clone());let research=research::ResearchService::new(store.clone());Ok(Self{store,codex,research,cancel:Arc::new(Mutex::new(HashMap::new()))})}
    fn arg<'a>(p:&'a Value,key:&str)->Result<&'a str>{p[key].as_str().ok_or_else(||Error::new("PARAM",format!("Нет {key}")))}
    pub fn handle(&self,request:Request)->Response{let result=self.dispatch(&request.method,&request.params);match result{Ok(value)=>Response{id:request.id,result:Some(value),error:None},Err(error)=>Response{id:request.id,result:None,error:Some(error)}}}
    fn dispatch(&self,method:&str,p:&Value)->Result<Value>{match method {
        "capabilities"=>Ok(json!({"protocol":2,"durableCommands":true,"durableCancellation":true,"exactResultAcceptance":true,"profile":"native-builtins","arbitraryCode":false,"codex":false,"osContainmentAccepted":false,"gpuAllocation":false,"backgroundHostSourcePresent":true,"codexDirect":{"protocol":1,"profile":"read-only","nativeAcceptance":"pending","osContainmentAccepted":false,"economy":codex::economy::capabilities()}})),
        "research_checkpoint"=>self.store.research_checkpoint(Self::arg(p,"taskId")?,p["investigationId"].as_str()),
        "research_sweep"=>self.research.execute(&p["request"],p["expectedSequence"].as_u64().unwrap_or(0)),
        "research_reconcile"=>research::import_saved(&self.store,Self::arg(p,"taskId")?,Self::arg(p,"sweepId")?),
        "tasks_list"=>self.store.task_list(),
        "task_create"=>self.store.create_task(&p["task"]),
        "task_read"=>self.store.task(Self::arg(p,"taskId")?),
        "task_revise"=>self.store.revise_task(Self::arg(p,"taskId")?,p["expectedRevision"].as_u64().ok_or_else(||Error::new("PARAM","Нет редакции"))?,Self::arg(p,"original")?),
        "task_sessions"=>self.store.executor_sessions(Self::arg(p,"taskId")?),
        "codex_configure"=>self.codex.configure(Path::new(Self::arg(p,"executable")?),p["acknowledgeDirectProfile"].as_bool()==Some(true)),
        "codex_open"=>self.codex.open(Self::arg(p,"taskId")?,Self::arg(p,"sessionId")?,Self::arg(p,"commandId")?,p["externalThreadId"].as_str()),
        "codex_submit"=>self.codex.submit(Self::arg(p,"sessionId")?,Self::arg(p,"commandId")?,p["goalRevision"].as_u64().ok_or_else(||Error::new("PARAM","Нет редакции"))?,Self::arg(p,"text")?,None),
        "codex_steer"=>self.codex.submit(Self::arg(p,"sessionId")?,Self::arg(p,"commandId")?,p["goalRevision"].as_u64().ok_or_else(||Error::new("PARAM","Нет редакции"))?,Self::arg(p,"text")?,Some(Self::arg(p,"expectedTurnId")?)),
        "codex_interrupt"=>self.codex.interrupt(Self::arg(p,"sessionId")?,Self::arg(p,"commandId")?,Self::arg(p,"expectedTurnId")?),
        "codex_reconcile"=>self.codex.reconcile(Self::arg(p,"sessionId")?),
        "codex_disconnect"=>self.codex.close(Self::arg(p,"sessionId")?),
        "codex_session"=>self.store.executor_session(Self::arg(p,"sessionId")?),
        "codex_commands"=>self.store.external_commands(Self::arg(p,"sessionId")?),
        "codex_abandon_prepared"=>self.store.abandon_prepared_external(Self::arg(p,"commandId")?),
        "codex_command"=>self.store.external_command(Self::arg(p,"commandId")?),
        "codex_events"=>self.store.session_events(Self::arg(p,"sessionId")?,p["afterSequence"].as_u64().unwrap_or(0)),
        "load_state"=>Ok(self.store.load_state()?.unwrap_or(Value::Null)),
        "save_state"=>{let expected=p["expected"].as_u64().ok_or_else(||Error::new("PARAM","Нет expected"))?;self.store.save_state(p["state"].clone(),expected)?;Ok(json!({"saved":true}))},
        "start_run"=>{let encoded=Self::arg(p,"specJson")?;
            ensure(encoded.len()<=24*1024*1024,"LIMIT","Снимок команды слишком велик")?;
            let spec:Value=serde_json::from_str(encoded)?;
            let doc:Document=serde_json::from_value(spec["document"].clone())?;let files:Vec<FileData>=serde_json::from_value(spec["files"].clone())?;
            let(run,fresh)=self.store.reserve_encoded(Self::arg(p,"commandId")?,encoded)?;
            if fresh {let cancel=Arc::new(AtomicBool::new(false));self.cancel.lock().map_err(|_|Error::new("LOCK","Отказ диспетчера"))?.insert(run.id.clone(),cancel.clone());
                let store=self.store.clone();let cancellations=self.cancel.clone();let task=run.clone();let task_id=run.id.clone();
                let spawned=std::thread::Builder::new().name(format!("builtin-{}",run.id)).spawn(move||{
                    if store.cancelled(&task.id).unwrap_or(true) { cancel.store(true,Ordering::SeqCst); }
                    let work=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||engine::execute(&doc,&files,task.clone(),&cancel,|r|{ if store.cancelled(&r.id)? { cancel.store(true,Ordering::SeqCst); } store.save_run(r) })));
                    if !matches!(work,Ok(Ok(_))) {
                        if let Ok(mut failed)=store.get_run(&task.id) { if failed.state=="running" {
                            let cancelled=store.cancelled(&task.id).unwrap_or(true);
                            failed.state=if cancelled {"cancelled"} else {"interrupted"}.into();
                            failed.error=Some("Исполнитель остановлен; незавершённый результат не принят".into());
                            failed.artifacts.clear(); failed.finished_at=Some(now());
                            for state in failed.nodes.values_mut() { if state=="running" || state=="queued" { *state="cancelled".into(); } }
                            let _=store.save_run(&failed);
                        } }
                    }
                    if let Ok(mut c)=cancellations.lock(){c.remove(&task_id);}
                });
                if let Err(e)=spawned{if let Ok(mut flags)=self.cancel.lock(){flags.remove(&run.id);}let mut failed=run.clone();failed.state="failed".into();failed.error=Some(e.to_string());self.store.save_run(&failed)?;return Err(e.into());}
            }Ok(serde_json::to_value(run)?)},
        "get_command"=>Ok(serde_json::to_value(self.store.command_run(Self::arg(p,"commandId")?)?)?),
        "get_run"=>Ok(serde_json::to_value(self.store.get_run(Self::arg(p,"runId")?)?)?),
        "cancel_run"=>{
            let run_id=Self::arg(p,"runId")?;
            let r=self.store.request_cancel(run_id)?; // durable before signalling the thread
            if r.cancel_requested { if let Some(c)=self.cancel.lock().map_err(|_|Error::new("LOCK","Отказ диспетчера"))?.get(run_id){c.store(true,Ordering::SeqCst);} }
            Ok(json!({"accepted":true,"cancelRequested":r.cancel_requested,"state":r.state,"stopped":r.state!="running"}))
        },
        "accept_run"=>Ok(serde_json::to_value(self.store.accept(Self::arg(p,"runId")?,Self::arg(p,"expectedBinding")?)?)?),
        "export_proposal"=>{
            let r=self.store.accepted_run(Self::arg(p,"runId")?,Self::arg(p,"expectedBinding")?)?;
            let wanted=Self::arg(p,"artifactHash")?;
            let a=r.artifacts.iter().find(|a|a.hash==wanted).ok_or_else(||Error::new("ARTIFACT","Нет выбранного артефакта"))?;
            let path=files::export_proposal(Path::new(Self::arg(p,"parent")?),a)?;
            Ok(json!({"path":path.to_string_lossy(),"sourceModified":false,"bindingHash":Self::arg(p,"expectedBinding")?}))
        },
        _=>Err(Error::new("METHOD","Команда не разрешена"))
    }}
}
#[cfg(windows)]pub fn request(method:&str,params:Value)->Result<Value>{windows::request(method,params)}
#[cfg(not(windows))]pub fn request(_method:&str,_params:Value)->Result<Value>{Err(Error::new("WINDOWS_ONLY","Нативный IPC требует Windows; используйте тесты ядра"))}
#[cfg(test)]mod tests {use super::*;#[test]fn oversized_frame_rejected(){let mut r=std::io::Cursor::new(((MAX_FRAME+1)as u32).to_le_bytes());assert!(read_frame(&mut r).is_err());}#[test]fn frame_roundtrip(){let mut bytes=vec![];write_frame(&mut bytes,b"hello").unwrap();assert_eq!(read_frame(&mut std::io::Cursor::new(bytes)).unwrap(),b"hello");}#[test]fn zero_frame_rejected(){assert!(read_frame(&mut std::io::Cursor::new([0u8;4])).is_err());}}

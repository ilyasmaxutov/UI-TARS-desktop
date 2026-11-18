//! One accepted application intent -> at most one send attempt in this adapter.
//! Native source integration; Windows build and real-provider acceptance remain open.
pub mod protocol;
pub mod economy;
mod peer;
use peer::Peer;
use serde_json::{json,Value};
use studio_core::{model::*,store::Store,task_store::field};
use std::{collections::HashMap,path::{Path,PathBuf},sync::{Arc,Mutex,atomic::Ordering}};

pub struct Director { store:Arc<Store>, peers:Mutex<HashMap<String,Arc<Peer>>>, connect:Mutex<()>, executable:Mutex<Option<PathBuf>> }
impl Director {
 pub fn new(store:Arc<Store>)->Self{Self{store,peers:Mutex::new(HashMap::new()),connect:Mutex::new(()),executable:Mutex::new(None)}}
 pub fn configure(&self,path:&Path,acknowledge:bool)->Result<Value>{
  ensure(acknowledge,"CONSENT","Нужно явно разрешить Direct-профиль; гарантий полной площадки нет")?;
  ensure(path.is_absolute()&&path.is_file(),"CODEX_EXE","Нужен существующий абсолютный путь codex.exe")?;
  #[cfg(windows)]ensure(path.extension().and_then(|s|s.to_str()).is_some_and(|s|s.eq_ignore_ascii_case("exe")),"CODEX_EXE","Нужен native EXE, не shell shim")?;
  ensure(self.peers.lock().map_err(|_|Error::new("LOCK","Сессии недоступны"))?.values().all(|p|!p.alive.load(Ordering::SeqCst)),"ACTIVE","Сначала отключите активные сессии")?;
  *self.executable.lock().map_err(|_|Error::new("LOCK","Настройки недоступны"))?=Some(path.to_owned());
  Ok(json!({"configured":true,"profile":"codex-direct","access":"read-only","platformIsolationAccepted":false,"automaticApproval":false,"economy":economy::capabilities()}))
 }
 fn peer(&self,session_id:&str)->Result<Arc<Peer>>{
  {let map=self.peers.lock().map_err(|_|Error::new("LOCK","Сессии недоступны"))?;if let Some(p)=map.get(session_id){if p.alive.load(Ordering::SeqCst){return Ok(p.clone());}}}
  // This lock serializes only connection creation; interrupt/read use the independent peer map.
  let _connecting=self.connect.lock().map_err(|_|Error::new("LOCK","Подключение недоступно"))?;
  {let mut map=self.peers.lock().map_err(|_|Error::new("LOCK","Сессии недоступны"))?;if let Some(p)=map.get(session_id){if p.alive.load(Ordering::SeqCst){return Ok(p.clone());}}
   map.retain(|_,p|p.alive.load(Ordering::SeqCst));ensure(map.len()<2,"SESSION_LIMIT","Не более двух процессов Codex в первом профиле")?;}
  let executable=self.executable.lock().map_err(|_|Error::new("LOCK","Нет настройки"))?.clone().ok_or_else(||Error::new("CODEX_UNCONFIGURED","Выберите Codex и разрешите подключение"))?;
  let session=self.store.executor_session(session_id)?;let task=self.store.task(field(&session,"taskId")?)?;let workspace=Path::new(field(&task["binding"],"rootPath")?);
  let peer=Peer::spawn(&executable,workspace,session_id,self.store.clone())?;
  self.peers.lock().map_err(|_|Error::new("LOCK","Сессии недоступны"))?.insert(session_id.into(),peer.clone());Ok(peer)
 }
 fn send_once(&self,peer:&Peer,command:Value)->Result<Value>{
  let id=field(&command,"id")?;
  if !self.store.begin_external_dispatch(id)?{return self.store.external_command(id);}
  let recorded=self.store.external_command(id)?;
  if let Err(error)=peer.dispatch(&recorded){let current=self.store.external_command(id)?;if current["state"]=="in_flight"{self.store.finish_external(id,"unverified_outcome",None,None,&error.to_string())?;}}
  self.store.external_command(id)
 }
 pub fn open(&self,task_id:&str,session_id:&str,command_id:&str,external_thread:Option<&str>)->Result<Value>{
  if let Some(existing)=self.store.find_external_command(command_id)?{ensure(existing["taskId"]==task_id&&existing["sessionId"]==session_id&&matches!(existing["method"].as_str(),Some("thread/start")|Some("thread/resume")),"ID_CONFLICT","Команда другой сессии или операции")?;return Ok(json!({"session":self.store.executor_session(session_id)?,"command":existing}));}
  let session=self.store.new_executor_session(task_id,session_id,external_thread)?;
  ensure(!matches!(session["status"].as_str(),Some("running")|Some("connecting")),"ACTIVE","Активную сессию нельзя переподключать; используйте сверку или остановку")?;
  let commands=self.store.external_commands(session_id)?;
  ensure(!commands.as_array().is_some_and(|cs|cs.iter().any(|c|c["method"]=="thread/start"&&c["state"]!="confirmed"&&c["state"]!="rejected")),"UNKNOWN_THREAD","Создание треда не подтверждено. Новый тред автоматически не создаётся")?;
  let peer=self.peer(session_id)?;let task=self.store.task(task_id)?;
  let mut params=json!({"cwd":task["binding"]["rootPath"],"sandbox":"read-only","approvalPolicy":"never"});
  let method=if let Some(thread)=session["externalThreadId"].as_str(){params["threadId"]=json!(thread);params["excludeTurns"]=json!(true);"thread/resume"}else{"thread/start"};
  params["developerInstructions"]=json!(format!("Report to the owner in Russian. Do not launch GUI applications, browsers, development servers, or Computer Use. Remain in the selected read-only profile. Task ID: {}; goal revision: {}. Preserve the exact original goal supplied by the owner.\n{}",task_id,task["goalRevision"],include_str!("../../../../tools/economy/diagnosis-first.txt")));
  let command=self.store.prepare_external(command_id,session_id,task["goalRevision"].as_u64().unwrap_or(1),method,&params,None,None)?;
  let command=self.send_once(&peer,command)?;
  Ok(json!({"session":self.store.executor_session(session_id)?,"command":command}))
 }
 pub fn submit(&self,session_id:&str,id:&str,revision:u64,text:&str,expected_turn:Option<&str>)->Result<Value>{
  let method=if expected_turn.is_some(){"turn/steer"}else{"turn/start"};
  let(marker,exact)=protocol::marked_input(id,text)?;
  if let Some(old)=self.store.find_external_command(id)?{ensure(old["sessionId"]==session_id&&old["exactInput"]==exact&&old["method"]==method&&old["goalRevision"].as_u64()==Some(revision)&&old["expectedTurnId"].as_str()==expected_turn,"ID_CONFLICT","ID повторно использован для другого поручения")?;return Ok(old);}
  let session=self.store.executor_session(session_id)?;
  let peer={let map=self.peers.lock().map_err(|_|Error::new("LOCK","Сессии недоступны"))?;map.get(session_id).filter(|p|p.alive.load(Ordering::SeqCst)).cloned().ok_or_else(||Error::new("DISCONNECTED","Сначала подключите и сверьте сессию"))?};
  let thread=field(&session,"externalThreadId")?;let mut params=json!({"threadId":thread,"input":[{"type":"text","text":exact}]});
  if let Some(turn)=expected_turn{params["expectedTurnId"]=json!(turn);}
  let command=self.store.prepare_external(id,session_id,revision,method,&params,Some(&marker),Some(&exact))?;self.send_once(&peer,command)
 }
 pub fn interrupt(&self,session_id:&str,id:&str,turn_id:&str)->Result<Value>{
  if let Some(old)=self.store.find_external_command(id)?{ensure(old["sessionId"]==session_id&&old["method"]=="turn/interrupt"&&old["expectedTurnId"]==turn_id,"ID_CONFLICT","Чужая команда остановки")?;return Ok(old);}
  let session=self.store.executor_session(session_id)?;ensure(session["lastKnownTurnId"]==turn_id,"STALE_TURN","Выбран другой ход")?;
  let task=self.store.task(field(&session,"taskId")?)?;let peer={let map=self.peers.lock().map_err(|_|Error::new("LOCK","Сессии недоступны"))?;map.get(session_id).filter(|p|p.alive.load(Ordering::SeqCst)).cloned().ok_or_else(||Error::new("DISCONNECTED","Нет живого транспорта; нужна сверка"))?};
  let params=json!({"threadId":session["externalThreadId"],"turnId":turn_id});let command=self.store.prepare_external(id,session_id,task["goalRevision"].as_u64().unwrap_or(1),"turn/interrupt",&params,None,None)?;self.send_once(&peer,command)
 }
 pub fn reconcile(&self,session_id:&str)->Result<Value>{
  let session=self.store.executor_session(session_id)?;
  let Some(thread_id)=session["externalThreadId"].as_str()else{return Ok(json!({"session":session,"commands":self.store.external_commands(session_id)?,"notice":"ID создаваемого треда не подтверждён. Автоматический повтор запрещён."}));};
  let peer=self.peer(session_id)?;
  let snapshot=peer.call("thread/read",json!({"threadId":thread_id}))?;
  ensure(snapshot["thread"]["id"].as_str()==Some(thread_id),"THREAD","Получен другой тред")?;
  let page=peer.call("thread/turns/list",json!({"threadId":thread_id,"limit":50,"sortDirection":"desc","itemsView":"full"}))?;
  let turns=page["data"].as_array().ok_or_else(||Error::new("READBACK","Нет списка ходов"))?;
  let commands=self.store.external_commands(session_id)?;
  for command in commands.as_array().into_iter().flatten(){
   if matches!(command["state"].as_str(),Some("in_flight")|Some("unverified_outcome")|Some("unknown_needs_user_decision")){
    let loaded=matches!(snapshot["thread"]["status"]["type"].as_str(),Some("idle")|Some("active"));
    let remote=if command["method"]=="thread/resume"&&loaded&&command["expectedThreadId"].as_str()==Some(thread_id){Some(thread_id.to_owned())}else{protocol::reconcile_match(command,thread_id,turns)};
    if command["state"]=="in_flight"{self.store.finish_external(field(command,"id")?,"unverified_outcome",None,None,"explicit_reconciliation")?;}
    self.store.finish_external(field(command,"id")?,if remote.is_some(){"confirmed"}else{"unknown_needs_user_decision"},remote.as_deref(),None,if remote.is_some(){"exact_user_item_readback"}else{"not_proven; no automatic replay"})?;
   }
  }
  let mut thread=snapshot["thread"].clone();thread["turns"]=json!(turns);self.store.observe_thread_snapshot(session_id,&peer.generation,&thread)?;
  Ok(json!({"session":self.store.executor_session(session_id)?,"commands":self.store.external_commands(session_id)?,"history":page,"notice":"Прочитана ограниченная страница. Исторические streaming-дельты и скрытые фазы не восстановлены."}))
 }
 pub fn close(&self,session_id:&str)->Result<Value>{if let Some(peer)=self.peers.lock().map_err(|_|Error::new("LOCK","Сессии недоступны"))?.remove(session_id){peer.close();}Ok(self.store.executor_session(session_id)?)}
}

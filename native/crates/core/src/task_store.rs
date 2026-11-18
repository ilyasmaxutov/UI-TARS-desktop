//! Durable application tasks and non-idempotent provider commands, independent of graph runs.
//! Native compilation and Windows acceptance must be recorded separately from SQL fixture tests.
use crate::sql_integer::{from_sql_u64, to_sql_u64};
use crate::{files, model::*, store::Store};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

fn string<'a>(v:&'a Value,k:&str)->Result<&'a str>{v[k].as_str().ok_or_else(||Error::new("PARAM",format!("Нет {k}")))}
fn valid_id(s:&str)->bool{!s.is_empty()&&s.len()<=128&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')}
pub fn field<'a>(v:&'a Value,k:&str)->Result<&'a str>{string(v,k)}
fn session_row(r:&rusqlite::Row<'_>)->rusqlite::Result<Value>{Ok(json!({
 "id":r.get::<_,String>(0)?,"taskId":r.get::<_,String>(1)?,"externalThreadId":r.get::<_,Option<String>>(2)?,
 "lastKnownTurnId":r.get::<_,Option<String>>(3)?,"profileKind":"codex-direct", "generation":r.get::<_,String>(4)?,
 "status":r.get::<_,String>(5)?,"prunedThrough":r.get::<_,i64>(6)?
}))}
const SESSION_SELECT:&str="SELECT id,task_id,external_thread_id,last_known_turn_id,generation,status,pruned_through FROM executor_sessions";
fn command_row(r:&rusqlite::Row<'_>)->rusqlite::Result<Value>{
 let text:String=r.get(7)?;let payload=serde_json::from_str::<Value>(&text).map_err(|e|rusqlite::Error::FromSqlConversionFailure(7,rusqlite::types::Type::Text,Box::new(e)))?;
 Ok(json!({"id":r.get::<_,String>(0)?,"taskId":r.get::<_,String>(1)?,"sessionId":r.get::<_,String>(2)?,
 "goalRevision":r.get::<_,i64>(3)?,"generation":r.get::<_,String>(4)?,"method":r.get::<_,String>(5)?,
 "fingerprint":r.get::<_,String>(6)?,"params":payload,"expectedThreadId":r.get::<_,Option<String>>(8)?,
 "expectedTurnId":r.get::<_,Option<String>>(9)?,"marker":r.get::<_,Option<String>>(10)?,"exactInput":r.get::<_,Option<String>>(11)?,
 "state":r.get::<_,String>(12)?,"revision":r.get::<_,i64>(13)?,"attempts":r.get::<_,i64>(14)?,
 "remoteId":r.get::<_,Option<String>>(15)?,"reason":r.get::<_,Option<String>>(16)?}))
}
const COMMAND_SELECT:&str="SELECT id,task_id,session_id,goal_revision,generation,method,fingerprint,params_json,expected_thread_id,expected_turn_id,marker,exact_input,state,revision,attempts,remote_id,reason FROM external_commands";

impl Store {
 pub fn create_task(&self,input:&Value)->Result<Value>{
  let id=string(input,"id")?;let project=string(input,"projectId")?;let title=string(input,"title")?;let original=string(input,"original")?;
  ensure(valid_id(id)&&valid_id(project)&&!title.trim().is_empty()&&title.len()<=300&&original.len()<=65536,"TASK","Некорректная задача")?;
  let binding=&input["binding"];
  ensure(binding["kind"]=="mounted"&&binding["access"]=="read-only","PROFILE","Первый Direct-профиль — read-only. Запись ещё не принята")?;
  let root=std::path::Path::new(string(binding,"rootPath")?);
  ensure(root.is_absolute()&&root.is_dir(),"WORKSPACE","Выберите существующий абсолютный каталог")?;
  let meta=std::fs::symlink_metadata(root)?;ensure(!meta.file_type().is_symlink(),"WORKSPACE_LINK","Корневая ссылка требует отдельного профиля")?;
  #[cfg(windows)] {use std::os::windows::fs::MetadataExt;ensure(meta.file_attributes()&0x400==0,"WORKSPACE_LINK","Reparse-корень не принят")?;}
  let encoded=serde_json::to_string(binding)?;
  let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
  let existing:Option<(String,String,String)>=tx.query_row("SELECT project_id,original,binding_json FROM tasks WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
  if let Some((p,o,b))=existing{ensure(p==project&&o==original&&b==encoded,"ID_CONFLICT","ID задачи уже занят другим содержимым")?;drop(tx);drop(c);return self.task(id);}
  let count:i64=tx.query_row("SELECT count(*) FROM tasks",[],|r|r.get(0))?;ensure(count<1000,"TASK_LIMIT","Нужен архив задач")?;
  let at=now();let progress=json!({"noProgress":0,"maxNoProgress":3,"evidence":[],"closed":[]});
  tx.execute("INSERT INTO tasks VALUES(?1,?2,?3,1,?4,?5,?6,?7,?7)",params![id,project,title,original,encoded,progress.to_string(),at])?;
  tx.execute("INSERT INTO task_goal_revisions VALUES(?1,1,?2,?3)",params![id,original,at])?;tx.commit()?;drop(c);self.task(id)
 }
 pub fn task(&self,id:&str)->Result<Value>{
  let c=self.lock()?;let(p,t,r,o,b,g):(String,String,i64,String,String,String)=c.query_row("SELECT project_id,title,goal_revision,original,binding_json,progress_json FROM tasks WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
  Ok(json!({"id":id,"projectId":p,"title":t,"goalRevision":r,"original":o,"binding":serde_json::from_str::<Value>(&b)?,"progress":serde_json::from_str::<Value>(&g)?}))
 }
 pub fn task_list(&self)->Result<Value>{let ids:Vec<String>={let c=self.lock()?;let mut q=c.prepare("SELECT id FROM tasks ORDER BY updated_at DESC LIMIT 1000")?;let it=q.query_map([],|r|r.get(0))?;it.collect::<std::result::Result<Vec<_>,_>>()?};let mut out=vec![];for id in ids{out.push(self.task(&id)?);}Ok(json!(out))}
 pub fn revise_task(&self,id:&str,expected:u64,original:&str)->Result<Value>{
  ensure(!original.trim().is_empty()&&original.len()<=65536,"GOAL","Неверная цель")?;
  let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;let next=expected.checked_add(1).ok_or_else(||Error::new("REVISION","Переполнение"))?;
  ensure(tx.execute("UPDATE tasks SET original=?1,goal_revision=?2,updated_at=?3 WHERE id=?4 AND goal_revision=?5",params![original,to_sql_u64(next)?,now(),id,to_sql_u64(expected)?])?==1,"GOAL_CONFLICT","Цель уже изменена; черновик сохраните отдельно")?;
  tx.execute("INSERT INTO task_goal_revisions VALUES(?1,?2,?3,?4)",params![id,to_sql_u64(next)?,original,now()])?;tx.commit()?;drop(c);self.task(id)
 }
 pub fn new_executor_session(&self,task_id:&str,session_id:&str,thread_id:Option<&str>)->Result<Value>{
  ensure(valid_id(session_id),"SESSION","Неверный ID сессии")?;
  if let Some(old)=self.find_executor_session(session_id)?{ensure(old["taskId"]==task_id,"SESSION_CONFLICT","Чужая задача")?;if let Some(thread)=thread_id{ensure(old["externalThreadId"].as_str()==Some(thread),"SESSION_CONFLICT","Сессия уже привязана к другому треду")?;}return Ok(old);}
  let _=self.task(task_id)?;let c=self.lock()?;c.execute("INSERT INTO executor_sessions(id,task_id,external_thread_id,profile_kind,generation,status,created_at,updated_at) VALUES(?1,?2,?3,'codex-direct',?4,'disconnected',?5,?5)",params![session_id,task_id,thread_id,new_id("peer"),now()])?;drop(c);self.executor_session(session_id)
 }
 pub fn find_executor_session(&self,id:&str)->Result<Option<Value>>{let c=self.lock()?;Ok(c.query_row(&format!("{SESSION_SELECT} WHERE id=?1"),[id],session_row).optional()?)}
 pub fn executor_session(&self,id:&str)->Result<Value>{let c=self.lock()?;Ok(c.query_row(&format!("{SESSION_SELECT} WHERE id=?1"),[id],session_row)?)}
 pub fn executor_sessions(&self,task_id:&str)->Result<Value>{let c=self.lock()?;let mut q=c.prepare(&format!("{SESSION_SELECT} WHERE task_id=?1 ORDER BY created_at"))?;let rows=q.query_map([task_id],session_row)?;Ok(json!(rows.collect::<std::result::Result<Vec<_>,_>>()?))}
 pub fn set_session_generation(&self,id:&str,generation:&str)->Result<()> {
  let c=self.lock()?;ensure(c.execute("UPDATE executor_sessions SET generation=?1,status='connecting',updated_at=?2 WHERE id=?3",params![generation,now(),id])?==1,"SESSION","Нет сессии")?;Ok(())
 }
 pub fn session_disconnect(&self,id:&str,generation:&str)->Result<()> {
  let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
  tx.execute("UPDATE executor_sessions SET status='disconnected',updated_at=?1 WHERE id=?2 AND generation=?3",params![now(),id,generation])?;
  tx.execute("UPDATE external_commands SET state='unverified_outcome',revision=revision+1,reason='transport_closed',updated_at=?1 WHERE session_id=?2 AND generation=?3 AND state='in_flight'",params![now(),id,generation])?;tx.commit()?;Ok(())
 }
 pub fn recover_executor_sessions(&self)->Result<()> {
  let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
  tx.execute("UPDATE external_commands SET state='unverified_outcome',revision=revision+1,reason='host_restarted',updated_at=?1 WHERE state='in_flight'",[now()])?;
  tx.execute("UPDATE executor_sessions SET status='disconnected',updated_at=?1",[now()])?;tx.commit()?;Ok(())
 }
 pub fn find_external_command(&self,id:&str)->Result<Option<Value>>{let c=self.lock()?;Ok(c.query_row(&format!("{COMMAND_SELECT} WHERE id=?1"),[id],command_row).optional()?)}
 pub fn external_command(&self,id:&str)->Result<Value>{let c=self.lock()?;Ok(c.query_row(&format!("{COMMAND_SELECT} WHERE id=?1"),[id],command_row)?)}
 pub fn external_commands(&self,session_id:&str)->Result<Value>{let c=self.lock()?;let mut q=c.prepare(&format!("{COMMAND_SELECT} WHERE session_id=?1 ORDER BY created_at DESC LIMIT 1000"))?;let rows=q.query_map([session_id],command_row)?;Ok(json!(rows.collect::<std::result::Result<Vec<_>,_>>()?))}
 /// Atomically retire a never-dispatched command, including an IPC request not yet inserted.
 /// A tombstone prevents its delayed arrival from triggering the external operation.
 pub fn abandon_prepared_external(&self,id:&str)->Result<Value>{
  ensure(valid_id(id),"COMMAND","Неверный ID команды")?;
  let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
  let state:Option<String>=tx.query_row("SELECT state FROM external_commands WHERE id=?1",[id],|r|r.get(0)).optional()?;
  ensure(state.as_deref().is_none_or(|s|s=="prepared"),"MAY_HAVE_BEEN_SENT","Команда могла быть отправлена. Нужна сверка, не сброс")?;
  if state.is_some(){tx.execute("UPDATE external_commands SET state='rejected',revision=revision+1,reason='cancelled_before_dispatch',updated_at=?1 WHERE id=?2 AND state='prepared'",params![now(),id])?;}
  tx.execute("INSERT OR IGNORE INTO external_command_tombstones VALUES(?1,?2,'cancelled_before_dispatch')",params![id,now()])?;
  tx.commit()?;Ok(json!({"id":id,"state":"cancelled_before_dispatch","externalSendPermitted":false}))
 }
 pub fn prepare_external(&self,id:&str,session_id:&str,goal_revision:u64,method:&str,params_value:&Value,marker:Option<&str>,exact_input:Option<&str>)->Result<Value>{
  ensure(valid_id(id),"COMMAND","Неверный ID команды")?;
  ensure(["thread/start","thread/resume","turn/start","turn/steer","turn/interrupt"].contains(&method),"METHOD","Операция не разрешена")?;
  let encoded=serde_json::to_string(params_value)?;ensure(encoded.len()<=128*1024,"COMMAND_LIMIT","Поручение слишком велико")?;
  let expected_thread=params_value["threadId"].as_str();let expected_turn=params_value["expectedTurnId"].as_str().or(params_value["turnId"].as_str());
  let fingerprint=files::hash(format!("{session_id}\n{goal_revision}\n{method}\n{encoded}").as_bytes());
  let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
  let existing:Option<String>=tx.query_row("SELECT fingerprint FROM external_commands WHERE id=?1",[id],|r|r.get(0)).optional()?;
  if let Some(old)=existing{ensure(old==fingerprint,"ID_CONFLICT","Один ID для разных поручений")?;drop(tx);drop(c);return self.external_command(id);}
  let session=tx.query_row(&format!("{SESSION_SELECT} WHERE id=?1"),[session_id],session_row)?;let task_id=string(&session,"taskId")?;
  let current:u64=tx.query_row("SELECT goal_revision FROM tasks WHERE id=?1",[task_id],|r|from_sql_u64(r,0))?;
  ensure(current==goal_revision||method=="turn/interrupt","STALE_GOAL","Поручение относится к старой редакции цели")?;
  if method=="turn/start"||method=="turn/steer" {
   let unresolved:i64=tx.query_row("SELECT count(*) FROM external_commands WHERE session_id=?1 AND method IN ('thread/start','turn/start','turn/steer') AND state IN ('prepared','in_flight','unverified_outcome','unknown_needs_user_decision')",[session_id],|r|r.get(0))?;
   ensure(unresolved==0,"UNRESOLVED","Сначала сверка прежней команды")?;
   ensure(session["status"]==if method=="turn/start"{"idle"}else{"running"},"SESSION_STATE","Состояние сессии не допускает действие")?;
   if method=="turn/steer"{ensure(expected_turn==session["lastKnownTurnId"].as_str(),"STALE_TURN","Активный ход изменился")?;}
  }
  if expected_thread.is_some(){ensure(expected_thread==session["externalThreadId"].as_str(),"THREAD","Чужой тред")?;}
  tx.execute("INSERT INTO external_commands(id,session_id,task_id,goal_revision,generation,method,params_json,fingerprint,expected_thread_id,expected_turn_id,marker,exact_input,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)",params![id,session_id,task_id,to_sql_u64(goal_revision)?,string(&session,"generation")?,method,encoded,fingerprint,expected_thread,expected_turn,marker,exact_input,now()])?;
  tx.commit()?;drop(c);self.external_command(id)
 }
 /// The send fence is committed BEFORE bytes can enter a pipe or queue.
 pub fn begin_external_dispatch(&self,id:&str)->Result<bool>{
  let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
  let row=tx.query_row(&format!("{COMMAND_SELECT} WHERE id=?1"),[id],command_row)?;
  if row["state"]!="prepared" {return Ok(false);}
  let session=tx.query_row(&format!("{SESSION_SELECT} WHERE id=?1"),[string(&row,"sessionId")?],session_row)?;
  ensure(row["generation"]==session["generation"],"GENERATION","Устаревшее подключение; подготовленная команда не отправлена")?;
  let task_revision:u64=tx.query_row("SELECT goal_revision FROM tasks WHERE id=?1",[string(&row,"taskId")?],|r|from_sql_u64(r,0))?;
  ensure(row["method"]=="turn/interrupt"||row["goalRevision"].as_u64()==Some(task_revision),"STALE_GOAL","Цель изменилась перед отправкой")?;
  tx.execute("UPDATE external_commands SET state='in_flight',attempts=1,revision=revision+1,updated_at=?1 WHERE id=?2 AND state='prepared'",params![now(),id])?;tx.commit()?;Ok(true)
 }
 pub fn finish_external(&self,id:&str,state:&str,remote_id:Option<&str>,result:Option<&Value>,reason:&str)->Result<Value>{
  let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
  let row=tx.query_row(&format!("{COMMAND_SELECT} WHERE id=?1"),[id],command_row)?;
  if row["state"]=="confirmed"||row["state"]=="rejected" {drop(tx);drop(c);return Ok(row);}
  let result_json=result.map(serde_json::to_string).transpose()?;
  tx.execute("UPDATE external_commands SET state=?1,remote_id=?2,result_json=?3,reason=?4,revision=revision+1,updated_at=?5 WHERE id=?6",params![state,remote_id,result_json,reason,now(),id])?;
  if state=="confirmed" {
   let method=string(&row,"method")?;
   if method=="thread/start"||method=="thread/resume" {
    let remote=remote_id.ok_or_else(||Error::new("RECEIPT","Нет ID треда"))?;
    let status=match result.and_then(|v|v["thread"]["status"]["type"].as_str()){Some("idle")=>"idle",Some("active")=>"state_unknown",Some("notLoaded")=>"disconnected",_=>if method=="thread/start"{"idle"}else{"state_unknown"}};
    tx.execute("UPDATE executor_sessions SET external_thread_id=?1,status=?2,updated_at=?3 WHERE id=?4 AND generation=?5",params![remote,status,now(),string(&row,"sessionId")?,string(&row,"generation")?])?;
   }
   if method=="turn/start" {
    let remote=remote_id.ok_or_else(||Error::new("RECEIPT","Нет ID хода"))?;
    let done:i64=tx.query_row("SELECT count(*) FROM session_events WHERE session_id=?1 AND generation=?2 AND json_extract(frame_json,'$.method')='turn/completed' AND json_extract(frame_json,'$.params.turn.id')=?3",params![string(&row,"sessionId")?,string(&row,"generation")?,remote],|r|r.get(0))?;
    let status=if done>0{"idle"}else if result.is_some_and(|v|v["turn"]["status"]=="inProgress"){"running"}else{"state_unknown"};
    tx.execute("UPDATE executor_sessions SET last_known_turn_id=?1,status=?2,updated_at=?3 WHERE id=?4 AND generation=?5",params![remote,status,now(),string(&row,"sessionId")?,string(&row,"generation")?])?;
   }
   // A start ACK must NOT overwrite a completion notification that arrived first.
  }
  tx.commit()?;drop(c);self.external_command(id)
 }
 pub fn append_session_event(&self,session_id:&str,generation:&str,frame:&Value)->Result<u64>{
  self.append_observation(session_id,generation,frame,"codex")
 }
 pub fn append_host_event(&self,session_id:&str,generation:&str,frame:&Value)->Result<u64>{
  self.append_observation(session_id,generation,frame,"host")
 }
 fn append_observation(&self,session_id:&str,generation:&str,frame:&Value,origin:&str)->Result<u64>{
  let mut clean=frame.clone();redact(&mut clean,0);let mut encoded=serde_json::to_string(&clean)?;
  let truncated=encoded.len()>256*1024;
  if truncated {clean=json!({"method":frame["method"],"id":frame["id"],"params":{"threadId":frame["params"]["threadId"],"turnId":frame["params"]["turnId"]},"notice":"frame exceeds preview budget; content omitted"});encoded=clean.to_string();}
  let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
  let s=tx.query_row(&format!("{SESSION_SELECT} WHERE id=?1"),[session_id],session_row)?;
  let owned=s["generation"]==generation;
  tx.execute("INSERT INTO session_events(session_id,generation,at,origin,frame_json,truncated) VALUES(?1,?2,?3,?4,?5,?6)",params![session_id,generation,now(),origin,encoded,truncated])?;
  let seq=tx.last_insert_rowid();
  if owned&&origin=="codex" {
   let p=&frame["params"];let thread=p["threadId"].as_str();let target_ok=thread.is_some()&&(s["externalThreadId"].is_null()||s["externalThreadId"].as_str()==thread);
   if target_ok&&frame["method"]=="turn/started" {
    if let Some(turn)=p["turn"]["id"].as_str(){tx.execute("UPDATE executor_sessions SET external_thread_id=COALESCE(external_thread_id,?1),last_known_turn_id=?2,status='running',updated_at=?3 WHERE id=?4",params![thread,turn,now(),session_id])?;}
   }else if target_ok&&frame["method"]=="turn/completed" {
    if let Some(turn)=p["turn"]["id"].as_str(){tx.execute("UPDATE executor_sessions SET status='idle',updated_at=?1 WHERE id=?2 AND last_known_turn_id=?3",params![now(),session_id,turn])?;}
   }
  }
  // Private local event ring: gaps are explicit; this is not a claim of lossless whole-OS logging.
  tx.execute("UPDATE executor_sessions SET event_count=event_count+1,event_bytes=event_bytes+?1 WHERE id=?2",params![encoded.len() as i64,session_id])?;
  let(mut count,mut bytes):(i64,i64)=tx.query_row("SELECT event_count,event_bytes FROM executor_sessions WHERE id=?1",[session_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
  // Constant-size accounting on normal events; only visit old rows when a limit is exceeded.
  while count>8192 || bytes>32*1024*1024 {
   let mut q=tx.prepare("SELECT sequence,length(CAST(frame_json AS BLOB)) FROM session_events WHERE session_id=?1 ORDER BY sequence LIMIT 128")?;
   let sizes=q.query_map([session_id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;drop(q);
   ensure(!sizes.is_empty(),"EVENT_ACCOUNTING","Нарушен учёт журнала")?;
   let mut prune=0;for(n,size)in sizes{prune=n;count-=1;bytes-=size;if count<=8192&&bytes<=32*1024*1024{break;}}
   tx.execute("DELETE FROM session_events WHERE session_id=?1 AND sequence<=?2",params![session_id,prune])?;
   tx.execute("UPDATE executor_sessions SET pruned_through=MAX(pruned_through,?1),event_count=?2,event_bytes=?3 WHERE id=?4",params![prune,count,bytes,session_id])?;
  }
  tx.commit()?;Ok(seq as u64)
 }
 pub fn session_events(&self,session_id:&str,after:u64)->Result<Value>{
  let c=self.lock()?;let pruned:u64=c.query_row("SELECT pruned_through FROM executor_sessions WHERE id=?1",[session_id],|r|from_sql_u64(r,0))?;
  let mut q=c.prepare("SELECT sequence,generation,at,origin,frame_json,truncated FROM session_events WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 128")?;
  let rows=q.query_map(params![session_id,to_sql_u64(after)?],|r|Ok((from_sql_u64(r,0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,bool>(5)?)))?;
  let mut out=vec![];let mut cursor=after.max(pruned);let mut size=0usize;
  for row in rows {let(seq,generation,at,origin,text,truncated)=row?;if !out.is_empty()&&size+text.len()>1024*1024{break;}size+=text.len();out.push(json!({"sequence":seq,"sessionId":session_id,"generation":generation,"at":at,"origin":origin,"frame":serde_json::from_str::<Value>(&text)?,"truncated":truncated}));cursor=seq;}
  Ok(json!({"events":out,"nextSequence":cursor,"gap":after<pruned,"coverage":"bounded local frames; host receipt timestamps"}))
 }
 pub fn observe_thread_snapshot(&self,session_id:&str,generation:&str,thread:&Value)->Result<()> {
  let s=self.executor_session(session_id)?;ensure(s["externalThreadId"]==thread["id"],"THREAD","Сверка другого треда")?;
  let active=thread["turns"].as_array().and_then(|ts|ts.iter().rev().find(|t|t["status"]=="inProgress")).and_then(|t|t["id"].as_str());
  let idle=thread["status"]["type"]=="idle";
  let state=if thread["status"]["type"]=="notLoaded"{"disconnected"}else if active.is_some(){"running"}else if idle{"idle"}else{"state_unknown"};
  let c=self.lock()?;c.execute("UPDATE executor_sessions SET status=?1,last_known_turn_id=COALESCE(?2,last_known_turn_id),updated_at=?3 WHERE id=?4 AND generation=?5",params![state,active,now(),session_id,generation])?;Ok(())
 }
}
fn redact(v:&mut Value,depth:usize){if depth>32{*v=json!("[depth limit]");return;}match v {Value::Object(map)=>{for(k,v)in map{if ["authorization","access_token","refresh_token","id_token","api_key","apikey","password","cookie"].contains(&k.to_ascii_lowercase().as_str()){*v=json!("[redacted]");}else{redact(v,depth+1);}}},Value::Array(a)=>{for v in a{redact(v,depth+1);}},_=>{}}}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> (PathBuf, Store) {
        let root = std::env::temp_dir().join(new_id("studio_direct_test"));
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        let store = Store::open(&root.join("state")).unwrap();
        store.create_task(&json!({
            "id":"task", "projectId":"project", "title":"Direct test", "original":"Original goal",
            "binding":{"kind":"mounted","id":"binding","rootPath":root.join("workspace"),"access":"read-only"}
        })).unwrap();
        store.new_executor_session("task", "session", Some("thread")).unwrap();
        store.set_session_generation("session", "g").unwrap();
        store.observe_thread_snapshot("session", "g", &json!({"id":"thread","status":{"type":"idle"},"turns":[]})).unwrap();
        (root, store)
    }
    fn prepare(store: &Store) {
        store.prepare_external("command", "session", 1, "turn/start",
            &json!({"threadId":"thread","input":[{"type":"text","text":"Original goal [nonce]"}]}),
            Some("[nonce]"), Some("Original goal [nonce]")).unwrap();
    }
    fn cleanup(root: PathBuf, store: Store) { drop(store); std::fs::remove_dir_all(root).unwrap(); }

    #[test]
    fn intent_fence_survives_restart_without_resend() {
        let (root, store) = fixture(); prepare(&store);
        assert!(store.begin_external_dispatch("command").unwrap()); drop(store);
        let store = Store::open(&root.join("state")).unwrap();
        store.recover_executor_sessions().unwrap();
        let row = store.external_command("command").unwrap();
        assert_eq!(row["state"], "unverified_outcome");
        assert_eq!(row["attempts"], 1);
        assert!(!store.begin_external_dispatch("command").unwrap());
        cleanup(root, store);
    }
    #[test]
    fn changed_goal_blocks_prepared_command() {
        let (root, store) = fixture(); prepare(&store);
        store.revise_task("task", 1, "Changed goal").unwrap();
        assert!(store.begin_external_dispatch("command").is_err());
        assert_eq!(store.external_command("command").unwrap()["attempts"], 0);
        cleanup(root, store);
    }
    #[test]
    fn completion_before_ack_does_not_resurrect_turn() {
        let (root, store) = fixture(); prepare(&store);
        store.begin_external_dispatch("command").unwrap();
        for method in ["turn/started", "turn/completed"] {
            store.append_session_event("session", "g", &json!({"method":method,"params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}})).unwrap();
        }
        store.finish_external("command", "confirmed", Some("turn"), Some(&json!({"turn":{"id":"turn","status":"inProgress"}})), "ack").unwrap();
        assert_eq!(store.executor_session("session").unwrap()["status"], "idle");
        cleanup(root, store);
    }
    #[test]
    fn old_generation_cannot_change_current_session() {
        let (root, store) = fixture();
        store.append_session_event("session", "old", &json!({"method":"turn/started","params":{"threadId":"thread","turn":{"id":"old-turn"}}})).unwrap();
        assert_eq!(store.executor_session("session").unwrap()["status"], "idle");
        cleanup(root, store);
    }
    #[test]
    fn progress_record_is_owned_by_task_not_session() {
        let (root, store) = fixture();
        store.lock().unwrap().execute("UPDATE tasks SET progress_json=?1 WHERE id='task'", [json!({"noProgress":2}).to_string()]).unwrap();
        store.new_executor_session("task", "second", Some("other-thread")).unwrap();
        assert_eq!(store.task("task").unwrap()["progress"]["noProgress"], 2);
        cleanup(root, store);
    }
    #[test]
    fn event_count_and_bytes_match_stored_frames() {
        let (root, store) = fixture();
        store.append_session_event("session", "g", &json!({"method":"example","params":{"text":"Пример","authorization":"fixture-secret"}})).unwrap();
        let page = store.session_events("session", 0).unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 1);
        assert!(!page.to_string().contains("fixture-secret"));
        let (count, bytes):(i64,i64) = store.lock().unwrap().query_row("SELECT event_count,event_bytes FROM executor_sessions WHERE id='session'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(count, 1); assert!(bytes > 0);
        cleanup(root, store);
    }

    #[test]
    fn oversized_owner_revisions_and_cursors_do_not_wrap_in_sqlite() {
        let (root, store) = fixture();
        let before = store.task("task").unwrap();
        let error = store.revise_task("task", u64::MAX - 1, "Must not be written").unwrap_err();
        assert_eq!(error.code, "SQL_INTEGER_RANGE");
        assert_eq!(store.task("task").unwrap(), before);
        assert_eq!(store.session_events("session", u64::MAX).unwrap_err().code, "SQL_INTEGER_RANGE");
        assert!(store.session_events("session", 0).unwrap()["events"].as_array().unwrap().is_empty());
        cleanup(root, store);
    }
}

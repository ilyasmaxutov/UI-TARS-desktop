//! A bounded stdio JSON-RPC client. Handshake/readback send no turn/start request.
//! Provider-side startup hooks, MCP and other ambient behavior require separate profile review.
use super::protocol;
use serde_json::{json,Value};
use studio_core::{model::*,store::Store};
use std::{collections::HashMap,io::{BufReader,Write},path::Path,process::{Child,Command,Stdio},sync::{Arc,Mutex,mpsc,atomic::{AtomicBool,Ordering}},time::Duration};
struct Pending { command:Option<String>, reply:mpsc::Sender<Result<Value>> }
pub struct Peer {
 pub generation:String, pub session_id:String, pub alive:AtomicBool,
 store:Arc<Store>, child:Mutex<Child>, writer:mpsc::SyncSender<Value>, pending:Mutex<HashMap<String,Pending>>,
}
impl Peer {
 pub fn spawn(executable:&Path,workspace:&Path,session_id:&str,store:Arc<Store>)->Result<Arc<Self>>{
  ensure(executable.is_absolute()&&executable.is_file(),"CODEX_EXE","Нужен явно выбранный нативный исполнимый файл Codex")?;
  #[cfg(windows)]ensure(executable.extension().and_then(|x|x.to_str()).is_some_and(|x|x.eq_ignore_ascii_case("exe")),"CODEX_EXE","CMD/PowerShell shim не запускается. Выберите codex.exe")?;
  let mut command=Command::new(executable);
  super::economy::configure(&mut command,workspace,&store)?;
  command.args(["-c","features.computer_use=false","-c","computer_use.default_app_access=\"deny\"","app-server"]).current_dir(workspace);
  Self::spawn_command(command,session_id,store)
 }
 // The production profile is assembled above. Keeping process transport separate
 // lets native CLI tests exercise real pipes and failure timing without a model.
 #[cfg(test)]
 pub(super) fn spawn_for_test(command:Command,session_id:&str,store:Arc<Store>)->Result<Arc<Self>>{
  Self::spawn_command(command,session_id,store)
 }
 fn spawn_command(mut command:Command,session_id:&str,store:Arc<Store>)->Result<Arc<Self>>{
  let generation=new_id("peer");store.set_session_generation(session_id,&generation)?;
  command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
  let mut child=command.spawn().map_err(|error|{let _=store.session_disconnect(session_id,&generation);Error::from(error)})?;let stdin=child.stdin.take().ok_or_else(||Error::new("PIPE","Нет stdin"))?;
  let stdout=child.stdout.take().ok_or_else(||Error::new("PIPE","Нет stdout"))?;let stderr=child.stderr.take().ok_or_else(||Error::new("PIPE","Нет stderr"))?;
  let(tx,rx)=mpsc::sync_channel::<Value>(64);
  let peer=Arc::new(Self{generation,session_id:session_id.into(),alive:AtomicBool::new(true),store,child:Mutex::new(child),writer:tx,pending:Mutex::new(HashMap::new())});
  let weak=Arc::downgrade(&peer);
  std::thread::spawn(move||{let mut stdin=stdin;while let Ok(frame)=rx.recv(){let data=match serde_json::to_vec(&frame){Ok(x)=>x,Err(_)=>break};if stdin.write_all(&data).and_then(|_|stdin.write_all(b"\n")).and_then(|_|stdin.flush()).is_err(){if let Some(p)=weak.upgrade(){p.fail("write_failed");}break;}}});
  let p=peer.clone();std::thread::spawn(move||{let mut reader=BufReader::new(stdout);loop{
   match protocol::read_line_limited(&mut reader){Ok(Some(line))=>match serde_json::from_slice::<Value>(&line){Ok(frame)=>{if let Err(e)=p.receive(frame){p.fail(&e.code);break;}},Err(_)=>{p.fail("malformed_frame");break;}},Ok(None)=>{p.fail("eof");break;},Err(e)=>{p.fail(&e.code);break;}}
  }});
  // Bounded private stderr, never injected into the model. This is not secret redaction.
  let diagnostics=peer.store.economy_root().join("diagnostics");let _=std::fs::create_dir_all(&diagnostics);
  let diagnostic=diagnostics.join(format!("{}.stderr",peer.generation));
  std::thread::spawn(move||{
   use std::io::Read;
   let meta=diagnostic.with_extension("stderr.json");
   let mut input=std::io::BufReader::new(stderr);
   let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&diagnostic).ok();
   let(mut kept,mut observed,mut complete)=(0usize,0u64,true);let mut buffer=[0u8;16384];
   loop{let n=match input.read(&mut buffer){Ok(0)=>break,Err(_)=>{complete=false;break},Ok(n)=>n};observed=observed.saturating_add(n as u64);
    let take=n.min((1024*1024usize).saturating_sub(kept));
    if take>0 {let written=file.as_mut().is_some_and(|f|f.write_all(&buffer[..take]).is_ok());if written{kept+=take;}else{complete=false;file=None;}}
   }
   if let Some(f)=file{if f.sync_all().is_err(){complete=false;}}
   let record=json!({"observedBytes":observed,"savedBytes":kept,"captureComplete":complete&&observed==kept as u64,"limitBytes":1048576,"redacted":false,"destination":"private-local-only"});
   if let Ok(bytes)=serde_json::to_vec(&record){let _=std::fs::write(meta,bytes);}
  });
  let init=protocol::initialize(&new_id("rpc"));if let Err(e)=peer.call_frame(init,None).and_then(|_|peer.send(json!({"method":"initialized"}))){peer.close();return Err(e);}Ok(peer)
 }
 fn send(&self,frame:Value)->Result<()>{ensure(self.alive.load(Ordering::SeqCst),"DISCONNECTED","Codex отключён")?;ensure(serde_json::to_vec(&frame)?.len()<=256*1024,"FRAME_LIMIT","Запрос слишком велик")?;self.writer.try_send(frame).map_err(|_|Error::new("QUEUE","Очередь Codex недоступна; исход надо сверить"))}
 pub fn call(&self,method:&str,params:Value)->Result<Value>{self.call_frame(json!({"id":new_id("rpc"),"method":method,"params":params}),None)}
 pub fn dispatch(&self,command:&Value)->Result<Value>{
  self.call_frame(json!({"id":new_id("rpc"),"method":command["method"],"params":command["params"]}),Some(command["id"].as_str().ok_or_else(||Error::new("COMMAND","Нет ID"))?.to_owned()))
 }
 fn call_frame(&self,frame:Value,command:Option<String>)->Result<Value>{
  self.call_frame_timeout(frame,command,Duration::from_secs(8))
 }
 fn call_frame_timeout(&self,frame:Value,command:Option<String>,timeout:Duration)->Result<Value>{
  let id=frame["id"].as_str().ok_or_else(||Error::new("RPC","Нет ID"))?.to_owned();let(tx,rx)=mpsc::channel();
  {let mut pending=self.pending.lock().map_err(|_|Error::new("LOCK","RPC недоступен"))?;ensure(pending.len()<128,"RPC_LIMIT","Слишком много ожидающих ответов")?;pending.insert(id.clone(),Pending{command:command.clone(),reply:tx});}
  if let Err(e)=self.send(frame){if let Ok(mut p)=self.pending.lock(){p.remove(&id);}return Err(e);}
  match rx.recv_timeout(timeout){Ok(result)=>result,Err(_)=>{
   // Keep external-command correlation for a late ACK; read requests can be discarded.
   if command.is_none(){if let Ok(mut p)=self.pending.lock(){p.remove(&id);}}
   Err(Error::new("RPC_TIMEOUT","Ответ Codex не получен. Повтор не выполняется"))
  }}
 }
 fn receive(&self,frame:Value)->Result<()>{
  if frame.get("method").is_some(){
   self.store.append_session_event(&self.session_id,&self.generation,&frame)?;
   if let Err(error)=crate::research::observe_mcp(&self.store,&self.session_id,&frame){
    // Do not fail the provider or automatically repeat a tool after an ingest gap.
    let notice=json!({"method":"studio/researchGap","params":{"code":error.code,"message":error.message}});
    let _=self.store.append_host_event(&self.session_id,&self.generation,&notice);
   }
   if frame.get("id").is_some(){
    // No implicit authority escalation. Interactive approval UI is a separate later capability.
    let result=match frame["method"].as_str(){
     Some("item/commandExecution/requestApproval")|Some("item/fileChange/requestApproval")=>Some(json!({"decision":"decline"})),
     Some("item/permissions/requestApproval")=>Some(json!({"permissions":{},"scope":"turn"})),
     _=>None
    };
    let response=if let Some(result)=result{json!({"id":frame["id"],"result":result})}else{json!({"id":frame["id"],"error":{"code":-32601,"message":"Client capability unavailable; no implicit action performed"}})};
    self.send(response)?;
   }
   return Ok(());
  }
  let Some(id)=frame["id"].as_str() else{return Err(Error::new("RPC_ID","Неизвестный формат ответа"));};
  let pending=self.pending.lock().map_err(|_|Error::new("LOCK","RPC недоступен"))?.remove(id);
  if let Some(pending)=pending {
   let result:Result<Value>=if let Some(error)=frame.get("error"){
    if let Some(cid)=pending.command.as_deref(){let rejected=matches!(error["code"].as_i64(),Some(-32601)|Some(-32602));self.store.finish_external(cid,if rejected{"rejected"}else{"unverified_outcome"},None,None,&format!("rpc_error: {}",error["code"]))?;}
    Err(Error::new("CODEX_RPC",error["message"].as_str().unwrap_or("Ошибка Codex")))
   }else if let Some(value)=frame.get("result"){
    if let Some(cid)=pending.command.as_deref(){let command=self.store.external_command(cid)?;let remote=protocol::receipt_id(&command,value)?;self.store.finish_external(cid,"confirmed",remote.as_deref(),Some(value),"rpc_response")?;}
    Ok(value.clone())
   }else{Err(Error::new("RPC_RESPONSE","Ответ без result/error"))};
   let _=pending.reply.send(result);
  }
  Ok(())
 }
 fn fail(&self,reason:&str){
  if !self.alive.swap(false,Ordering::SeqCst){return;}
  let _=self.store.session_disconnect(&self.session_id,&self.generation);
  if let Ok(mut pending)=self.pending.lock(){for(_,p)in pending.drain(){let _=p.reply.send(Err(Error::new("DISCONNECTED",reason)));}}
  if let Ok(mut child)=self.child.lock(){let _=child.kill();let _=child.wait();}
 }
 pub fn close(&self){self.fail("closed_by_owner");}
}
impl Drop for Peer{fn drop(&mut self){if let Ok(child)=self.child.get_mut(){let _=child.kill();let _=child.wait();}}}

#[cfg(test)]
#[path="../../tests/support/peer_transport.rs"]
mod tests;

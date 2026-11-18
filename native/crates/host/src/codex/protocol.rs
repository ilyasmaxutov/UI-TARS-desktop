use serde_json::{json,Value};
use studio_core::{model::*,task_store::field};
use std::io::BufRead;
pub const MAX_LINE:usize=4*1024*1024;
pub fn read_line_limited(reader:&mut impl BufRead)->Result<Option<Vec<u8>>>{
 let mut out=Vec::new();loop{let chunk=reader.fill_buf()?;if chunk.is_empty(){return if out.is_empty(){Ok(None)}else{Err(Error::new("TRUNCATED_FRAME","Незавершённый JSON-RPC кадр"))};}
 let count=chunk.iter().position(|b|*b==b'\n').map(|p|p+1).unwrap_or(chunk.len());
 ensure(out.len()+count<=MAX_LINE,"FRAME_LIMIT","Кадр Codex превышает 4 МиБ")?;let complete=chunk[count-1]==b'\n';out.extend_from_slice(&chunk[..count]);reader.consume(count);if complete{return Ok(Some(out));}}
}
pub fn initialize(id:&str)->Value{json!({"id":id,"method":"initialize","params":{"clientInfo":{"name":"platform_studio","title":"Platform Studio","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}}})}
/// Codex 0.170.0 on Windows reports this exact precondition before the first
/// user message creates persisted history. This is unavailable history, never
/// evidence that an uncertain command was not delivered.
pub fn unmaterialized_history(thread_id:&str,thread:&Value,error:&Error)->bool{
 error.code=="CODEX_RPC_INVALID_REQUEST"
  &&error.message==format!("thread {thread_id} is not materialized yet; thread/turns/list is unavailable before first user message")
  &&thread["id"].as_str()==Some(thread_id)&&thread["status"]["type"]=="idle"
  &&thread["turns"].as_array().is_some_and(Vec::is_empty)
}
pub fn marked_input(id:&str,text:&str)->Result<(String,String)>{
 ensure(!text.trim().is_empty()&&text.len()<=65536,"INPUT","Неверное поручение")?;
 let marker=format!("[PlatformStudio command {id}]");Ok((marker.clone(),format!("{text}\n\n{marker}")))
}
pub fn receipt_id(command:&Value,result:&Value)->Result<Option<String>>{
 let method=field(command,"method")?;let id=match method{
  "thread/start"|"thread/resume"=>result["thread"]["id"].as_str(),
  "turn/start"=>result["turn"]["id"].as_str(),
  "turn/steer"=>result["turnId"].as_str(),
  "turn/interrupt"=>command["expectedTurnId"].as_str(),_=>None
 }.ok_or_else(||Error::new("RECEIPT","Нет ID в подтверждении Codex"))?;
 if method=="thread/resume"{ensure(command["expectedThreadId"].as_str()==Some(id),"RECEIPT","Подтверждён чужой тред")?;}
 if method=="turn/steer"{ensure(command["expectedTurnId"].as_str()==Some(id),"RECEIPT","Подтверждён другой ход")?;}
 Ok(Some(id.to_string()))
}
/// Exact user-message nonce and payload in the SAME thread. Assistant echoes cannot prove delivery.
pub fn reconcile_match(command:&Value,thread_id:&str,turns:&[Value])->Option<String>{
 if command["expectedThreadId"].as_str()!=Some(thread_id){return None;}
 if command["method"]=="turn/interrupt" {return turns.iter().find(|t|t["id"]==command["expectedTurnId"]&&t["status"]=="interrupted").and_then(|t|t["id"].as_str()).map(str::to_owned);}
 if !matches!(command["method"].as_str(),Some("turn/start")|Some("turn/steer")){return None;}
 let exact=command["exactInput"].as_str()?;let marker=command["marker"].as_str()?;if !exact.contains(marker){return None;}
 let candidates:Vec<&Value>=turns.iter().filter(|turn|{
  if command["method"]=="turn/steer"&&turn["id"]!=command["expectedTurnId"]{return false;}
  turn["items"].as_array().is_some_and(|items|items.iter().any(|item|item["type"]=="userMessage"&&item["content"].as_array().is_some_and(|c|c.iter().any(|v|v["type"]=="text"&&v["text"].as_str()==Some(exact)))))
 }).collect();if candidates.len()==1{candidates[0]["id"].as_str().map(str::to_owned)}else{None}
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn framed_utf8(){let mut r=std::io::Cursor::new("{\"x\":\"текст\"}\n".as_bytes());assert!(serde_json::from_slice::<Value>(&read_line_limited(&mut r).unwrap().unwrap()).is_ok());}
 #[test]fn incomplete_frame(){assert!(read_line_limited(&mut std::io::Cursor::new(b"{\"id\":1}")).is_err());}
 #[test]fn oversized_frame(){assert!(read_line_limited(&mut std::io::Cursor::new(vec![b'x';MAX_LINE+1])).is_err());}
 #[test]fn protocol_no_bypass(){let init=initialize("r");assert_eq!(init["params"]["capabilities"]["experimentalApi"],false);}
 #[test]fn unmaterialized_history_requires_exact_error_and_matching_idle_empty_snapshot(){
  let thread=json!({"id":"thread","status":{"type":"idle"},"turns":[]});
  let message="thread thread is not materialized yet; thread/turns/list is unavailable before first user message";
  let error=Error::new("CODEX_RPC_INVALID_REQUEST",message);
  assert!(unmaterialized_history("thread",&thread,&error));
  assert!(!unmaterialized_history("other",&thread,&error));
  assert!(!unmaterialized_history("thread",&thread,&Error::new("CODEX_RPC",message)));
  assert!(!unmaterialized_history("thread",&thread,&Error::new("CODEX_RPC_INVALID_REQUEST",format!("{message}; backend failed"))));
  for incompatible in [json!({"id":"thread","status":{"type":"active"},"turns":[]}),json!({"id":"thread","status":{"type":"idle"}}),json!({"id":"thread","status":{"type":"idle"},"turns":[{"id":"turn"}]}),json!({"id":"foreign","status":{"type":"idle"},"turns":[]})]{assert!(!unmaterialized_history("thread",&incompatible,&error));}
 }
}

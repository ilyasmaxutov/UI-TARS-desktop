#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{Value,json};
use std::sync::Mutex;
static START_LOCK:Mutex<()>=Mutex::new(());
fn host(method:&str,params:Value)->Result<Value,String>{
 let _lock=START_LOCK.lock().map_err(|_|"Host launch mutex failed".to_string())?;
 if studio_host::request("capabilities",Value::Null).is_err(){
  #[cfg(windows)] {
   use std::os::windows::process::CommandExt;
   let exe=std::env::current_exe().map_err(|e|e.to_string())?.with_file_name("studio-host.exe");
   if !exe.is_file(){return Err("Рядом с приложением нет studio-host.exe. Выполните scripts/Build-Windows.ps1".into());}
   // Only this packaged, fixed executable can be started. No command string is accepted.
   std::process::Command::new(exe).creation_flags(0x08000000).spawn().map_err(|e|e.to_string())?;
   let mut ready=false;for _ in 0..40{std::thread::sleep(std::time::Duration::from_millis(100));if studio_host::request("capabilities",Value::Null).is_ok(){ready=true;break;}}
   if !ready{return Err("Хост не подтвердил готовность. Новые операции не начаты".into());}
  }
  #[cfg(not(windows))] return Err("Нативное приложение требует Windows 11".into());
 }
 let capabilities=studio_host::request("capabilities",Value::Null).map_err(|e|e.to_string())?;
 if capabilities["protocol"].as_u64()!=Some(2){return Err("Запущен хост другой версии. Завершите старый studio-host перед обновлением; команды не отправлены".into());}
 drop(_lock);studio_host::request(method,params).map_err(|e|format!("{}: {}",e.code,e.message))
}
async fn rpc(method:&'static str,params:Value)->Result<Value,String>{tauri::async_runtime::spawn_blocking(move||host(method,params)).await.map_err(|e|e.to_string())?}
#[tauri::command]async fn load_state()->Result<Value,String>{rpc("load_state",Value::Null).await}
#[tauri::command]async fn save_state(state:Value,expected:u64)->Result<Value,String>{rpc("save_state",json!({"state":state,"expected":expected})).await}
#[tauri::command]async fn start_run(spec_json:String,command_id:String)->Result<Value,String>{rpc("start_run",json!({"specJson":spec_json,"commandId":command_id})).await}
#[tauri::command]async fn get_command(command_id:String)->Result<Value,String>{rpc("get_command",json!({"commandId":command_id})).await}
#[tauri::command]async fn get_run(run_id:String)->Result<Value,String>{rpc("get_run",json!({"runId":run_id})).await}
#[tauri::command]async fn cancel_run(run_id:String)->Result<Value,String>{rpc("cancel_run",json!({"runId":run_id})).await}
#[tauri::command]async fn accept_run(run_id:String,expected_binding:String)->Result<Value,String>{rpc("accept_run",json!({"runId":run_id,"expectedBinding":expected_binding})).await}
#[tauri::command]async fn capabilities()->Result<Value,String>{rpc("capabilities",Value::Null).await}
#[tauri::command]async fn choose_folder()->Result<Value,String>{
 tauri::async_runtime::spawn_blocking(||{let Some(path)=rfd::FileDialog::new().set_title("Импортировать текстовые файлы — оригинал не изменяется").pick_folder()else{return Ok(Value::Null)};
  let files=studio_core::files::import_folder(&path).map_err(|e|format!("{}: {}",e.code,e.message))?;Ok(json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"files":files}))
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]async fn export_proposal(run_id:String,expected_binding:String,artifact_hash:String)->Result<Value,String>{
 let parent=tauri::async_runtime::spawn_blocking(||rfd::FileDialog::new().set_title("Создать отдельную папку результата — без перезаписи оригинала").pick_folder()).await.map_err(|e|e.to_string())?;
 let Some(parent)=parent else{return Ok(Value::Null)};rpc("export_proposal",json!({"runId":run_id,"expectedBinding":expected_binding,"artifactHash":artifact_hash,"parent":parent.to_string_lossy()})).await
}
/// Allowlisted application operations only. Not an arbitrary method proxy or shell executor.
#[tauri::command]async fn assistant_rpc(operation:String,params:Value)->Result<Value,String>{
 let method=match operation.as_str(){
 "tasks_list"=>"tasks_list","task_create"=>"task_create","task_read"=>"task_read","task_revise"=>"task_revise","task_sessions"=>"task_sessions",
 "codex_configure"=>"codex_configure","codex_open"=>"codex_open","codex_submit"=>"codex_submit","codex_steer"=>"codex_steer",
 "codex_interrupt"=>"codex_interrupt","codex_reconcile"=>"codex_reconcile","codex_disconnect"=>"codex_disconnect","codex_session"=>"codex_session",
 "codex_abandon_prepared"=>"codex_abandon_prepared",
 "research_checkpoint"=>"research_checkpoint","research_sweep"=>"research_sweep","research_reconcile"=>"research_reconcile",
 "codex_commands"=>"codex_commands","codex_command"=>"codex_command","codex_events"=>"codex_events",
 _=>return Err("Операция помощника не разрешена".into())}; rpc(method,params).await
}
#[tauri::command]async fn choose_workspace()->Result<Value,String>{
 tauri::async_runtime::spawn_blocking(||{let Some(path)=rfd::FileDialog::new().set_title("Привязать каталог без импорта содержимого · Codex Direct read-only").pick_folder()else{return Ok(Value::Null)};
 Ok(json!({"kind":"mounted","id":studio_core::model::new_id("binding"),"rootPath":path.to_string_lossy(),"access":"read-only"}))
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]async fn choose_codex()->Result<Value,String>{
 tauri::async_runtime::spawn_blocking(||Ok(rfd::FileDialog::new().set_title("Выбрать установленный native codex.exe — запуск отдельно").add_filter("Исполняемый файл",&["exe"]).pick_file().map(|p|json!(p.to_string_lossy())).unwrap_or(Value::Null))).await.map_err(|e|e.to_string())?
}
fn main(){tauri::Builder::default().invoke_handler(tauri::generate_handler![load_state,save_state,start_run,get_run,get_command,cancel_run,accept_run,capabilities,choose_folder,export_proposal,assistant_rpc,choose_workspace,choose_codex]).run(tauri::generate_context!()).expect("Platform Studio could not initialize");}

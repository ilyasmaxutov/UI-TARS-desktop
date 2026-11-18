//! Small local-tools profile. These settings are NOT a hard model-input budget.
//! The helper is a native standalone executable, not another agent or inference loop.
use std::{path::{Path,PathBuf},process::Command};
use serde_json::json;
use studio_core::{model::*,store::Store,files};
pub const PACKET_OUTPUT_BYTES:usize=24576;
pub fn helper_path()->Result<PathBuf>{
 let path=if let Some(explicit)=std::env::var_os("STUDIO_ECONOMY_EXE"){PathBuf::from(explicit)}else{std::env::current_exe()?.parent().ok_or_else(||Error::new("ECONOMY_HELPER","Нет каталога хоста"))?.join(if cfg!(windows){"studio-economy.exe"}else{"studio-economy"})};
 ensure(path.is_absolute()&&path.is_file(),"ECONOMY_HELPER","Рядом с studio-host нужен studio-economy.exe из поставки 0.4, либо явный STUDIO_ECONOMY_EXE. Ничего не скачивается")?;Ok(path)
}
pub fn profile_arguments(helper:&Path,workspace:&Path,state:&Path)->Result<Vec<String>>{
 let quote=|s:&str|serde_json::to_string(s).map_err(Error::from);
 let mcp=format!("mcp_servers.studio_economy={{command={},args=[\"mcp\",\"--project\",{},\"--state\",{}],startup_timeout_sec=15,tool_timeout_sec=660}}",quote(&helper.to_string_lossy())?,quote(&workspace.to_string_lossy())?,quote(&state.to_string_lossy())?);
 let mut values=vec![mcp];values.extend([
 "tool_output_token_limit=6000","model_context_window=48000","model_auto_compact_token_limit=36000",
 "model_post_turn_compact_threshold_percent=0","features.memories=false","memories.use_memories=false",
 "memories.generate_memories=false","features.multi_agent=false","agents.enabled=false","features.goals=false",
 "web_search=\"disabled\"","features.shell_tool=false","features.view_image=false", "tui.auto_recap=false",
 ].into_iter().map(str::to_owned));
 let mut args=Vec::new();for value in values{args.push("-c".into());args.push(value);}Ok(args)
}
pub fn configure(command:&mut Command,workspace:&Path,store:&Store)->Result<()> {
 let helper=helper_path()?;let project_key=files::hash(workspace.to_string_lossy().as_bytes());let state=store.economy_root().join(&project_key[..24]);
 // Tool results are bounded in the helper itself. Settings must still be accepted
 // by the actual installed Codex, and ambient MCP/hook behavior remains distinct.
 command.args(profile_arguments(&helper,workspace,&state)?);Ok(())
}
pub fn capabilities()->serde_json::Value{json!({"helperPresent":helper_path().is_ok(),"toolResultMaxBytes":PACKET_OUTPUT_BYTES,"modelInputHardLimit":false,"providerRetriesEnforced":false,"profileAcceptance":"pending-target-codex","localModelCalls":0})}
#[cfg(test)]mod tests{use super::*;
 #[test]fn profile_uses_local_stdio_without_bypass(){let a=profile_arguments(Path::new("C:/Tools/studio-economy.exe"),Path::new("C:/Work/P"),Path::new("C:/Private/S")).unwrap().join(" ");assert!(a.contains("mcp_servers.studio_economy"));assert!(a.contains("features.shell_tool=false"));assert!(!a.contains("bypass"));assert!(!a.contains("http://"));}
 #[test]fn does_not_replace_model_instructions_or_disable_safety_hooks(){let a=profile_arguments(Path::new("/tool"),Path::new("/project"),Path::new("/private")).unwrap().join(" ");assert!(!a.contains("model_instructions_file"));assert!(!a.contains("hooks=false"));}
}

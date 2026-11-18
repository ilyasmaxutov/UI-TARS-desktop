use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const MAX_FILE: usize = 1_048_576;
pub const MAX_TOTAL: usize = 8_388_608;
pub const MAX_FILES: usize = 256;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Serialize)]
pub struct Error { pub code: String, pub message: String }
impl Error { pub fn new(code: &str, message: impl Into<String>) -> Self { Self { code: code.into(), message: message.into() } } }
impl std::fmt::Display for Error { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f,"{}: {}",self.code,self.message) } }
impl std::error::Error for Error {}
impl From<std::io::Error> for Error { fn from(e: std::io::Error) -> Self { Self::new("IO", e.to_string()) } }
impl From<serde_json::Error> for Error { fn from(e: serde_json::Error) -> Self { Self::new("JSON", e.to_string()) } }
impl From<rusqlite::Error> for Error { fn from(e: rusqlite::Error) -> Self { Self::new("DATABASE", e.to_string()) } }
pub fn ensure(condition: bool, code: &str, message: impl Into<String>) -> Result<()> { if condition { Ok(()) } else { Err(Error::new(code,message)) } }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileData { pub path: String, pub content: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node { pub id: String, pub kind: String, pub title: String, pub params: BTreeMap<String,Value> }
impl Node { pub fn param(&self,key:&str)->&str { self.params.get(key).and_then(Value::as_str).unwrap_or("") } }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Edge { pub id: String, pub source: String, pub target: String, pub source_port: String, pub target_port: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Obligation { pub id: String, pub description: String, pub kind: String, pub path: String, pub value: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Goal { pub original: String, pub revision: u64, pub obligations: Vec<Obligation> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Document { pub schema: u32, pub id:String, pub project_id:String, pub title:String, pub revision:u64, pub goal:Goal, pub nodes:Vec<Node>, pub edges:Vec<Edge>, pub workspaces:Vec<Value> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Finding { pub obligation_id:String, pub description:String, pub passed:bool, pub detail:String }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManifestEntry { pub path:String, pub hash:String, pub bytes:usize }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Artifact { pub id:String, pub files:Vec<FileData>, pub manifest:Vec<ManifestEntry>, pub hash:String, pub goal_revision:u64, pub graph_revision:u64, pub findings:Vec<Finding> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Event { pub seq:u64, pub run_id:String, pub at:String, pub kind:String, pub node_id:Option<String>, pub message:String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Run { pub id:String, pub document_id:String, pub revision:u64, pub goal_revision:u64, pub state:String, pub started_at:String, pub finished_at:Option<String>, pub nodes:BTreeMap<String,String>, pub previews:BTreeMap<String,String>, pub events:Vec<Event>, pub artifacts:Vec<Artifact>, pub error:Option<String>, pub profile:String, pub input_hash:String, pub document_hash:String, pub inputs:Vec<FileData>, pub goal:Goal, pub accepted:bool, #[serde(default,skip_serializing_if="Option::is_none")] pub command_fingerprint:Option<String>, #[serde(default)] pub cancel_requested:bool, #[serde(default,skip_serializing_if="Option::is_none")] pub acceptance:Option<AcceptanceReceipt> }
pub fn now()->String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true) }
pub fn new_id(prefix:&str)->String { format!("{prefix}_{}", uuid::Uuid::new_v4()) }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct AcceptanceReceipt { pub schema:u32, pub run_id:String, pub binding_hash:String, pub artifact_hashes:Vec<String>, pub at:String, pub actor:String, pub scope:String }

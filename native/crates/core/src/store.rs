use crate::{engine, files, graph, model::*, review};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex, time::Duration};
pub struct Store { connection: Mutex<Connection>, root: PathBuf }
impl Store {
    pub fn economy_root(&self) -> PathBuf { self.root.join("economy") }
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?; fs::create_dir_all(root.join("artifacts"))?;
        let mut c = Connection::open(root.join("studio.sqlite3"))?;
        c.busy_timeout(Duration::from_secs(3))?;
        let version: String = c.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
        let tuple = version.split('.').map(|x| x.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();
        ensure(tuple.as_slice() >= [3,51,3].as_slice(), "SQLITE_VERSION", "This source profile requires SQLite >= 3.51.3")?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
        let schema: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure(schema <= 4, "SCHEMA_NEWER", "Database was written by a newer application")?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(include_str!("schema/v1.sql"))?;
        tx.execute_batch(include_str!("schema/v2.sql"))?;
        tx.execute_batch(include_str!("schema/v3.sql"))?;
        tx.execute_batch(include_str!("schema/v4.sql"))?;
        tx.execute_batch("PRAGMA user_version=4;")?;
        tx.commit()?;
        Ok(Self { connection: Mutex::new(c), root: root.to_owned() })
    }
    pub(crate) fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| Error::new("STORE_POISONED", "Хранилище недоступно; новые эффекты запрещены"))
    }
    pub fn load_state(&self) -> Result<Option<Value>> {
        let c = self.lock()?;
        let text: Option<String> = c.query_row("SELECT payload FROM ui_state WHERE id=1", [], |r| r.get(0)).optional()?;
        let Some(text) = text else { return Ok(None) };
        let mut state: Value = serde_json::from_str(&text)?;
        let mut q = c.prepare("SELECT payload FROM runs ORDER BY created DESC LIMIT 30")?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?;
        let mut runs = vec![];
        for row in rows { runs.push(serde_json::from_str::<Value>(&row?)?); }
        runs.reverse(); state["runs"] = Value::Array(runs); Ok(Some(state))
    }
    pub fn save_state(&self, mut state: Value, expected: u64) -> Result<()> {
        let revision = expected.checked_add(1).ok_or_else(|| Error::new("STATE", "Revision overflow"))?;
        ensure(state["schema"] == 1 && state["revision"].as_u64() == Some(revision), "STATE", "Неверная редакция состояния")?;
        let projects = state["projects"].as_array().ok_or_else(|| Error::new("STATE", "Нет проектов"))?;
        ensure(!projects.is_empty() && projects.len() <= 32, "LIMIT", "Неверное число проектов")?;
        let mut ids = std::collections::BTreeSet::new();
        for project in projects {
            let doc: Document = serde_json::from_value(project["document"].clone())?;
            graph::validate_document(&doc)?;
            let data: Vec<FileData> = serde_json::from_value(project["files"].clone())?;
            files::validate_files(&data)?;
            ensure(project["id"].as_str() == Some(doc.project_id.as_str()) && ids.insert(doc.project_id), "STATE", "Повтор проекта или чужой документ")?;
        }
        ensure(state["activeProject"].as_str().is_some_and(|id| ids.contains(id)), "STATE", "Неизвестный активный проект")?;
        state["runs"] = json!([]); // UI never writes authoritative run or acceptance records.
        let data = serde_json::to_string(&state)?;
        ensure(data.len() <= 32*1024*1024, "LIMIT", "Состояние слишком велико")?;
        let mut c = self.lock()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<u64> = tx.query_row("SELECT revision FROM ui_state WHERE id=1", [], |r| r.get(0)).optional()?;
        ensure(previous.unwrap_or(0) == expected, "CONFLICT", "Состояние уже изменено в другом окне")?;
        tx.execute("INSERT INTO ui_state VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload", params![revision,data])?;
        tx.commit()?; Ok(())
    }
    /// Commit command + frozen spec + run + control row before launching work.
    pub fn reserve_run(&self, command_id: &str, document: &Document, inputs: &[FileData]) -> Result<(Run, bool)> {
        let encoded = serde_json::to_string(&json!({"document":document,"files":inputs}))?;
        self.reserve_encoded(command_id, &encoded)
    }
    /// Preserve exact request bytes; no assumption about cross-language float formatting.
    pub fn reserve_encoded(&self, command_id: &str, spec: &str) -> Result<(Run, bool)> {
        ensure(spec.len() <= 24*1024*1024, "LIMIT", "Слишком большой снимок команды")?;
        let value: Value = serde_json::from_str(spec)?;
        let document: Document = serde_json::from_value(value["document"].clone())?;
        let inputs: Vec<FileData> = serde_json::from_value(value["files"].clone())?;
        ensure(!command_id.is_empty() && command_id.len() <= 128 && command_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'), "COMMAND", "Неверный ID команды")?;
        let fingerprint = files::hash(spec.as_bytes());
        let mut c = self.lock()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String)> = tx.query_row("SELECT fingerprint,run_id FROM commands WHERE id=?1", [command_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((old, run_id)) = existing {
            ensure(old == fingerprint, "ID_CONFLICT", "Команда с тем же ID изменилась")?;
            let payload: String = tx.query_row("SELECT payload FROM runs WHERE id=?1", [run_id], |r| r.get(0))?;
            return Ok((serde_json::from_str(&payload)?, false));
        }
        let count: u64 = tx.query_row("SELECT COUNT(*) FROM commands", [], |r| r.get(0))?;
        ensure(count < 10000, "STORE_LIMIT", "Нужен архив без потери дедупликации")?;
        let active: u32 = tx.query_row("SELECT COUNT(*) FROM runs WHERE state='running'", [], |r| r.get(0))?;
        ensure(active < 2, "BUSY", "Два рабочих слота заняты")?;
        let mut run = engine::prepare(&document, &inputs)?;
        run.command_fingerprint = Some(fingerprint.clone());
        tx.execute("INSERT INTO runs(id,state,spec,payload,created) VALUES(?1,?2,?3,?4,?5)", params![run.id,run.state,spec,serde_json::to_string(&run)?,run.started_at])?;
        tx.execute("INSERT INTO run_controls(run_id) VALUES(?1)", [&run.id])?;
        tx.execute("INSERT INTO commands VALUES(?1,?2,?3)", params![command_id,fingerprint,run.id])?;
        tx.commit()?; Ok((run, true))
    }
    pub fn command_run(&self, command_id: &str) -> Result<Option<Run>> {
        let c = self.lock()?;
        let payload: Option<String> = c.query_row("SELECT runs.payload FROM commands JOIN runs ON runs.id=commands.run_id WHERE commands.id=?1", [command_id], |r| r.get(0)).optional()?;
        payload.map(|s| serde_json::from_str(&s).map_err(Error::from)).transpose()
    }
    fn read_run(tx: &Transaction<'_>, id: &str) -> Result<Run> {
        let payload: String = tx.query_row("SELECT payload FROM runs WHERE id=?1", [id], |r| r.get(0))?;
        Ok(serde_json::from_str(&payload)?)
    }
    fn write_events(tx: &Transaction<'_>, run: &Run) -> Result<()> {
        let mut last = 0;
        ensure(run.events.len() <= 4096, "EVENT_LIMIT", "Слишком много событий")?;
        for event in &run.events {
            ensure(event.run_id == run.id && event.seq > last, "EVENT_SEQUENCE", "Некорректная последовательность")?;
            last = event.seq;
            let text = serde_json::to_string(event)?;
            let previous: Option<String> = tx.query_row("SELECT payload FROM events WHERE run_id=?1 AND seq=?2", params![run.id,event.seq], |r| r.get(0)).optional()?;
            if let Some(old) = previous { ensure(old == text, "EVENT_REWRITE", "Событие уже записано с другим содержимым")?; }
            else { tx.execute("INSERT INTO events VALUES(?1,?2,?3)", params![run.id,event.seq,text])?; }
        }
        Ok(())
    }
    fn store_artifacts(&self, run: &Run) -> Result<()> {
        for artifact in &run.artifacts {
            ensure(files::artifact_valid(artifact)? && !artifact.files.is_empty(), "ARTIFACT", "Некорректный артефакт")?;
            let path = self.root.join("artifacts").join(format!("{}.json", artifact.hash));
            if !path.exists() {
                let temp = self.root.join("artifacts").join(format!("{}.tmp", new_id("write")));
                let mut f = OpenOptions::new().write(true).create_new(true).open(&temp)?;
                f.write_all(&serde_json::to_vec(artifact)?)?; f.sync_all()?; drop(f);
                if let Err(error) = fs::rename(&temp, &path) { let _ = fs::remove_file(&temp); if !path.exists() { return Err(error.into()) } }
            }
            self.read_artifact(artifact)?;
        }
        Ok(())
    }
    fn read_artifact(&self, expected: &Artifact) -> Result<()> {
        ensure(expected.hash.len() == 64 && expected.hash.bytes().all(|b| b.is_ascii_hexdigit()), "ARTIFACT", "Некорректный хэш")?;
        let path = self.root.join("artifacts").join(format!("{}.json", expected.hash));
        let metadata = fs::symlink_metadata(&path)?;
        ensure(metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 64*1024*1024, "ARTIFACT_READBACK", "Недопустимый объект артефакта")?;
        #[cfg(windows)] { use std::os::windows::fs::MetadataExt; ensure(metadata.file_attributes() & 0x400 == 0, "REPARSE", "Reparse point не допускается")?; }
        let mut data = Vec::new();
        fs::File::open(path)?.take(64*1024*1024+1).read_to_end(&mut data)?;
        ensure(data.len() <= 64*1024*1024, "ARTIFACT_READBACK", "Артефакт вырос при чтении")?;
        let stored: Artifact = serde_json::from_slice(&data)?;
        ensure(files::artifact_valid(&stored)? && stored.hash == expected.hash && stored.files == expected.files,
            "ARTIFACT_READBACK", "Содержимое хранилища не совпало")
    }
    pub fn save_run(&self, incoming: &Run) -> Result<()> {
        let mut c = self.lock()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old = Self::read_run(&tx, &incoming.id)?;
        // Terminal writes are exclusively owned by accept(), not a delayed worker checkpoint.
        if old.state != "running" {
            ensure(serde_json::to_value(&old)? == serde_json::to_value(incoming)?, "TERMINAL_IMMUTABLE", "Завершённый запуск неизменяем")?;
            return Ok(());
        }
        ensure(!incoming.accepted && incoming.acceptance.is_none(), "WORKER_ACCEPTANCE", "Исполнитель не принимает собственный результат")?;
        ensure(old.document_id == incoming.document_id && old.revision == incoming.revision && old.goal_revision == incoming.goal_revision
            && old.command_fingerprint == incoming.command_fingerprint && old.document_hash == incoming.document_hash && old.input_hash == incoming.input_hash && old.inputs == incoming.inputs
            && serde_json::to_value(&old.goal)? == serde_json::to_value(&incoming.goal)? && old.started_at == incoming.started_at,
            "RUN_BINDING", "Снимок запуска изменён")?;
        ensure(old.events.last().map_or(0,|e|e.seq) <= incoming.events.last().map_or(0,|e|e.seq), "STALE_CHECKPOINT", "Устаревшее состояние исполнителя")?;
        let cancel: bool = tx.query_row("SELECT cancel_requested FROM run_controls WHERE run_id=?1", [&incoming.id], |r| r.get(0))?;
        ensure(!(cancel && incoming.state == "review"), "CANCELLED", "Отмена записана до предъявления результата")?;
        ensure(["running","review","failed","cancelled","interrupted"].contains(&incoming.state.as_str()), "STATE", "Неизвестное состояние")?;
        let mut run = incoming.clone(); run.cancel_requested = cancel;
        if run.state == "review" {
            let spec: String = tx.query_row("SELECT spec FROM runs WHERE id=?1", [&run.id], |r| r.get(0))?;
            let spec: Value = serde_json::from_str(&spec)?;
            review::inspect(&run, &serde_json::from_value(spec["document"].clone())?, &serde_json::from_value::<Vec<FileData>>(spec["files"].clone())?)?;
        }
        self.store_artifacts(&run)?;
        Self::write_events(&tx, &run)?;
        tx.execute("UPDATE runs SET state=?1,payload=?2 WHERE id=?3", params![run.state,serde_json::to_string(&run)?,run.id])?;
        tx.commit()?; Ok(())
    }
    pub fn get_run(&self, id: &str) -> Result<Run> {
        let c = self.lock()?;
        let text: String = c.query_row("SELECT payload FROM runs WHERE id=?1", [id], |r| r.get(0))?;
        Ok(serde_json::from_str(&text)?)
    }
    /// Cancellation receipt is durable. It does not assert process/resource termination.
    pub fn request_cancel(&self, id: &str) -> Result<Run> {
        let mut c = self.lock()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut run = Self::read_run(&tx, id)?;
        if run.state == "running" {
            tx.execute("UPDATE run_controls SET cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?1) WHERE run_id=?2", params![now(),id])?;
            run.cancel_requested = true;
            tx.execute("UPDATE runs SET payload=?1 WHERE id=?2", params![serde_json::to_string(&run)?,id])?;
        }
        tx.commit()?; Ok(run)
    }
    pub fn cancelled(&self, id: &str) -> Result<bool> {
        let c = self.lock()?;
        Ok(c.query_row("SELECT cancel_requested FROM run_controls WHERE run_id=?1", [id], |r| r.get(0))?)
    }
    pub fn accept(&self, id: &str, expected_binding: &str) -> Result<Run> {
        let mut c = self.lock()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut run = Self::read_run(&tx, id)?;
        let spec: String = tx.query_row("SELECT spec FROM runs WHERE id=?1", [id], |r| r.get(0))?;
        let spec: Value = serde_json::from_str(&spec)?;
        let checked = review::inspect(&run, &serde_json::from_value(spec["document"].clone())?, &serde_json::from_value::<Vec<FileData>>(spec["files"].clone())?)?;
        ensure(checked == expected_binding, "STALE_RESULT", "Показанный владельцу результат изменился")?;
        for artifact in &run.artifacts { self.read_artifact(artifact)?; }
        let (cancel, existing): (bool, Option<String>) = tx.query_row("SELECT cancel_requested,acceptance_binding FROM run_controls WHERE run_id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        ensure(!cancel, "CANCELLED", "Отмена запрещает принятие")?;
        if let Some(binding) = existing {
            ensure(binding == checked && run.accepted && run.acceptance.as_ref().is_some_and(|r|r.schema==1 && r.run_id==run.id && r.actor=="owner" && r.scope=="builtin-criteria" && r.binding_hash==checked && r.artifact_hashes==run.artifacts.iter().map(|a|a.hash.clone()).collect::<Vec<_>>()), "ACCEPTANCE", "Повреждено решение принятия")?;
            return Ok(run);
        }
        let at = now();
        run.accepted = true;
        run.acceptance = Some(AcceptanceReceipt { schema:1, run_id:run.id.clone(), binding_hash:checked.clone(), artifact_hashes:run.artifacts.iter().map(|a|a.hash.clone()).collect(), at:at.clone(), actor:"owner".into(), scope:"builtin-criteria".into() });
        tx.execute("UPDATE runs SET payload=?1 WHERE id=?2", params![serde_json::to_string(&run)?,id])?;
        tx.execute("UPDATE run_controls SET acceptance_binding=?1,accepted_at=?2 WHERE run_id=?3", params![checked,at,id])?;
        tx.commit()?; Ok(run)
    }
    pub fn accepted_run(&self, id: &str, expected_binding: &str) -> Result<Run> {
        // Idempotent reinspection also rereads all artifact bytes before exporting a proposal.
        let run = self.get_run(id)?;
        ensure(run.accepted && run.acceptance.is_some(), "ACCEPTANCE", "Сначала примите конкретный снимок")?;
        self.accept(id, expected_binding)
    }
    pub fn recover(&self) -> Result<usize> {
        let rows: Vec<String> = {
            let c = self.lock()?;
            let mut query = c.prepare("SELECT payload FROM runs WHERE state='running'")?;
            let rows = query.query_map([], |r| r.get::<_,String>(0))?;
            rows.collect::<std::result::Result<Vec<_>,_>>()?
        };
        for payload in &rows {
            let mut run: Run = serde_json::from_str(payload)?;
            run.cancel_requested = self.cancelled(&run.id)?;
            run.state = if run.cancel_requested { "cancelled" } else { "interrupted" }.into();
            run.error = Some(if run.cancel_requested { "Отмена сохранена до рестарта. Встроенный исполнитель прежнего процесса прекращён" } else { "Хост завершился до подтверждения результата; автоматического повтора нет" }.into());
            run.finished_at = Some(now()); run.artifacts.clear(); run.accepted = false; run.acceptance = None;
            for node in run.nodes.values_mut() { if node == "running" || node == "queued" { *node = "cancelled".into(); } }
            self.save_run(&run)?;
        }
        Ok(rows.len())
    }
}

//! Research checkpoints in the existing TaskStore. No new database or model loop.
//! Only the host's verified local helper path may record sweep observations.
use crate::sql_integer::{from_sql_u64, required_sql_u64, to_sql_u64};
use crate::{files, model::*, store::Store, task_store::field};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};

fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 96 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn digest_valid(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn latest(tx: &Transaction<'_>, task: &str, inv: &str) -> Result<Option<Value>> {
    let text: Option<String> = tx.query_row(
        "SELECT payload_json FROM task_research_checkpoints WHERE task_id=?1 AND investigation_id=?2 ORDER BY sequence DESC LIMIT 1",
        params![task, inv], |r| r.get(0)).optional()?;
    text.map(|s| serde_json::from_str(&s).map_err(Error::from)).transpose()
}
fn insert(tx: &Transaction<'_>, checkpoint: &Value) -> Result<()> {
    let p = &checkpoint["plan"];
    let text = serde_json::to_string(checkpoint)?;
    ensure(text.len() <= 524288, "RESEARCH_LIMIT", "Контрольная точка превышает 512 КиБ")?;
    let task = field(p, "taskId")?;
    let count: i64 = tx.query_row("SELECT count(*) FROM task_research_checkpoints WHERE task_id=?1", [task], |r| r.get(0))?;
    ensure(count < 256, "RESEARCH_LIMIT", "Нужен явный архив контрольных точек")?;
    tx.execute("INSERT INTO task_research_checkpoints VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![task, field(p,"investigationId")?, required_sql_u64(checkpoint,"sequence")?, required_sql_u64(p,"goalRevision")?, required_sql_u64(p,"planVersion")?, text, files::hash(text.as_bytes()), now()])?;
    Ok(())
}
impl Store {
    pub fn research_plan_known(&self, plan: &Value) -> Result<bool> {
        let c=self.lock()?;
        let text:Option<String>=c.query_row("SELECT json_extract(payload_json,'$.plan') FROM task_research_checkpoints WHERE task_id=?1 AND investigation_id=?2 AND goal_revision=?3 AND plan_version=?4 ORDER BY sequence DESC LIMIT 1",params![field(plan,"taskId")?,field(plan,"investigationId")?,required_sql_u64(plan,"goalRevision")?,required_sql_u64(plan,"planVersion")?],|r|r.get(0)).optional()?;
        if let Some(text)=text {let stored:Value=serde_json::from_str(&text)?;ensure(stored==*plan,"RESEARCH_CONFLICT","Содержание прежней версии плана изменено")?;Ok(true)}else{Ok(false)}
    }
    pub fn research_checkpoint(&self, task_id: &str, investigation_id: Option<&str>) -> Result<Value> {
        let c = self.lock()?;
        let text: Option<String> = if let Some(inv) = investigation_id {
            c.query_row("SELECT payload_json FROM task_research_checkpoints WHERE task_id=?1 AND investigation_id=?2 ORDER BY sequence DESC LIMIT 1", params![task_id,inv], |r|r.get(0)).optional()?
        } else {
            c.query_row("SELECT payload_json FROM task_research_checkpoints WHERE task_id=?1 ORDER BY (goal_revision=(SELECT goal_revision FROM tasks WHERE id=?1)) DESC,created_at DESC,rowid DESC LIMIT 1", [task_id], |r|r.get(0)).optional()?
        };
        text.map(|s|serde_json::from_str(&s).map_err(Error::from)).transpose().map(|v|v.unwrap_or(Value::Null))
    }
    /// Caller has validated the diagnostic schema with the existing helper.
    /// This method still protects task identity, goal history, sequence and limits.
    pub fn save_research_plan(&self, plan: &Value, expected: u64) -> Result<Value> {
        let task=field(plan,"taskId")?;let inv=field(plan,"investigationId")?;
        ensure(identifier(task)&&identifier(inv)&&plan["schema"]==1,"RESEARCH_ID","Неверная идентичность исследования")?;
        let revision=plan["goalRevision"].as_u64().ok_or_else(||Error::new("RESEARCH_REVISION","Нет редакции цели"))?;
        let version=plan["planVersion"].as_u64().ok_or_else(||Error::new("RESEARCH_REVISION","Нет версии плана"))?;
        let max_sweeps=plan["budget"]["maxSweeps"].as_u64().unwrap_or(0);
        let max_idle=plan["budget"]["maxNoProgress"].as_u64().unwrap_or(0);
        ensure((1..=32).contains(&max_sweeps)&&(1..=5).contains(&max_idle),"RESEARCH_LIMIT","Неверные пределы")?;
        let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let(current,progress):(u64,String)=tx.query_row("SELECT goal_revision,progress_json FROM tasks WHERE id=?1",[task],|r|Ok((from_sql_u64(r,0)?,r.get(1)?)))?;
        let original:String=tx.query_row("SELECT original FROM task_goal_revisions WHERE task_id=?1 AND revision=?2",params![task,to_sql_u64(revision)?],|r|r.get(0))?;
        ensure(plan["originalGoal"].as_str()==Some(original.as_str()),"GOAL_CONFLICT","Исходная редакция цели отличается")?;
        let old=latest(&tx,task,inv)?;
        if let Some(ref old)=old { if old["plan"]==*plan { return Ok(old.clone()); } }
        let actual=old.as_ref().and_then(|x|x["sequence"].as_u64()).unwrap_or(0);
        ensure(actual==expected,"RESEARCH_CONFLICT","Исследование уже изменено")?;
        let previous_version=old.as_ref().and_then(|x|x["plan"]["planVersion"].as_u64()).unwrap_or(0);
        ensure(version==previous_version+1,"RESEARCH_REVISION","Нужна следующая версия плана")?;
        let mut progress:Value=serde_json::from_str(&progress)?;
        if let Some(limit)=progress["researchLimit"].as_u64(){ensure(max_sweeps<=limit,"RESEARCH_LIMIT","Новая ветка не расширяет бюджет задачи")?;progress["researchLimit"]=json!(limit.min(max_sweeps));}
        else {progress["researchLimit"]=json!(max_sweeps);progress["researchSweeps"]=json!(0);}
        let old_max=progress["researchMaxNoProgress"].as_u64().unwrap_or(max_idle);
        ensure(max_idle<=old_max,"RESEARCH_LIMIT","Новый план не расширяет предел без прогресса")?;
        progress["researchMaxNoProgress"]=json!(old_max.min(max_idle));
        let checkpoint=json!({"schema":1,"sequence":actual+1,"plan":plan,"reports":old.as_ref().map(|x|x["reports"].clone()).unwrap_or(json!([])),"findings":old.as_ref().map(|x|x["findings"].clone()).unwrap_or(json!([])),"nextAction":if current==revision{"collect_read_only_evidence"}else{"Old-goal evidence retained; do not execute against the changed goal"},"status":if current==revision{"planning"}else{"blocked"}});
        insert(&tx,&checkpoint)?;
        tx.execute("UPDATE tasks SET progress_json=?1,updated_at=?2 WHERE id=?3",params![progress.to_string(),now(),task])?;
        tx.commit()?;Ok(checkpoint)
    }
    pub fn assert_research_admission(&self, task_id: &str, investigation_id: &str, plan_version: u64) -> Result<()> {
        let task=self.task(task_id)?;
        let cp=self.research_checkpoint(task_id,Some(investigation_id))?;
        ensure(!cp.is_null()&&cp["plan"]["planVersion"].as_u64()==Some(plan_version),"RESEARCH_PLAN","Нужен сохранённый актуальный план")?;
        ensure(cp["plan"]["goalRevision"]==task["goalRevision"]&&cp["plan"]["originalGoal"]==task["original"],"GOAL_CONFLICT","Исходная цель изменилась")?;
        let progress=&task["progress"];
        let count=progress["researchSweeps"].as_u64().unwrap_or(0);let limit=progress["researchLimit"].as_u64().unwrap_or(0);
        let idle=progress["noProgress"].as_u64().unwrap_or(0);let idle_limit=progress["maxNoProgress"].as_u64().unwrap_or(3).min(progress["researchMaxNoProgress"].as_u64().unwrap_or(3));
        ensure(count<limit&&idle<idle_limit,"RESEARCH_STOP","Лимит задачи достигнут. Новая сессия его не обнуляет")
    }
    /// A parsed, integrity-checked local report, never a model's 'success' text.
    /// Old-goal evidence is retained as stale, not reattached to the current goal.
    pub fn record_research_sweep(&self, report: &Value) -> Result<Value> {
        let task_id=field(report,"taskId")?;let inv=field(report,"investigationId")?;let sweep=field(report,"sweepId")?;
        ensure(identifier(sweep)&&digest_valid(field(report,"reportSha256")?)&&report["localModelCalls"]==0,"RESEARCH_REPORT","Неверное основание отчёта")?;
        let mut c=self.lock()?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut cp=latest(&tx,task_id,inv)?.ok_or_else(||Error::new("RESEARCH_PLAN","План не сохранён"))?;
        let known:i64=tx.query_row("SELECT count(*) FROM task_research_checkpoints WHERE task_id=?1 AND investigation_id=?2 AND goal_revision=?3 AND plan_version=?4",params![task_id,inv,required_sql_u64(report,"goalRevision")?,required_sql_u64(report,"planVersion")?],|r|r.get(0))?;
        ensure(known>0,"RESEARCH_REPORT","Отчёт неизвестной редакции")?;
        let reports=cp["reports"].as_array().ok_or_else(||Error::new("RESEARCH_REPORT","Нет массива отчётов"))?;
        if let Some(old)=reports.iter().find(|r|r["sweepId"].as_str()==Some(sweep)){
            ensure(old["reportSha256"]==report["reportSha256"],"SWEEP_ID_CONFLICT","Сохранённый отчёт изменился")?;return Ok(cp);
        }
        let (revision,text):(u64,String)=tx.query_row("SELECT goal_revision,progress_json FROM tasks WHERE id=?1",[task_id],|r|Ok((from_sql_u64(r,0)?,r.get(1)?)))?;
        let mut progress:Value=serde_json::from_str(&text)?;
        let evidence=report["evidenceRefs"].as_array().ok_or_else(||Error::new("RESEARCH_REPORT","Нет свидетельств"))?;
        ensure(evidence.len()<=32,"RESEARCH_REPORT","Слишком много свидетельств")?;
        let mut seen:Vec<String>=progress["evidence"].as_array().map(|a|a.iter().filter_map(|v|v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        ensure(seen.len()<=4096,"RESEARCH_LIMIT","Нужен архив оснований прогресса")?;
        let fresh_goal=Some(revision)==report["goalRevision"].as_u64()&&cp["plan"]["planVersion"]==report["planVersion"];let mut fresh=false;
        for ev in evidence {
            let key=field(ev,"noveltyKey")?;ensure(digest_valid(key),"RESEARCH_REPORT","Неверный ключ наблюдения")?;
            let useful=ev["coverage"]=="complete"||(ev["coverage"]=="partial"&&ev["negative"]==false);
            if fresh_goal&&useful&&report["sourceCoverage"]!="unknown"&&!seen.iter().any(|s|s==key){seen.push(key.into());fresh=true;}
        }
        let idle=progress["noProgress"].as_u64().unwrap_or(0);
        progress["noProgress"]=json!(if fresh{0}else{idle.saturating_add(1)});
        progress["evidence"]=json!(seen);
        progress["researchSweeps"]=json!(progress["researchSweeps"].as_u64().unwrap_or(0).saturating_add(1));
        let blocked=!fresh_goal||progress["researchSweeps"].as_u64().unwrap_or(0)>=progress["researchLimit"].as_u64().unwrap_or(0)||progress["noProgress"].as_u64().unwrap_or(0)>=progress["maxNoProgress"].as_u64().unwrap_or(3).min(progress["researchMaxNoProgress"].as_u64().unwrap_or(3));
        cp["sequence"]=json!(cp["sequence"].as_u64().unwrap_or(0)+1);
        cp["reports"].as_array_mut().ok_or_else(||Error::new("RESEARCH_REPORT","Повреждён массив отчётов"))?.push(report.clone());
        cp["status"]=json!(if blocked{"blocked"}else{"evaluating"});
        cp["nextAction"]=if blocked{json!("Review saved evidence and change the strategy or obtain an explicit owner decision; no automatic continuation")}else{report["nextAction"].clone()};
        insert(&tx,&cp)?;
        tx.execute("UPDATE tasks SET progress_json=?1,updated_at=?2 WHERE id=?3",params![progress.to_string(),now(),task_id])?;
        tx.commit()?;Ok(cp)
    }
}

#[cfg(test)]
mod tests {
 use super::*;
 use std::path::PathBuf;
 fn fixture()->(PathBuf,Store,Value){
  let root=std::env::temp_dir().join(new_id("research_test"));std::fs::create_dir_all(root.join("workspace")).unwrap();let store=Store::open(&root.join("state")).unwrap();
  let mut plan:Value=serde_json::from_str(include_str!("../../../../fixtures/research/resume-ack/request.json")).unwrap();plan=plan["plan"].clone();
  store.create_task(&json!({"id":plan["taskId"],"projectId":"p","title":"Research fixture","original":plan["originalGoal"],"binding":{"kind":"mounted","id":"b","rootPath":root.join("workspace"),"access":"read-only"}})).unwrap();
  (root,store,plan)
 }
 fn report(p:&Value,id:&str)->Value{json!({"schema":1,"sweepId":id,"investigationId":p["investigationId"],"taskId":p["taskId"],"goalRevision":p["goalRevision"],"planVersion":p["planVersion"],"localModelCalls":0,"reportSha256":"a".repeat(64),"sourceCoverage":"complete","evidenceRefs":[{"noveltyKey":"b".repeat(64),"coverage":"complete","negative":false}],"nextAction":"evaluate_once"})}
 fn cleanup(root:PathBuf,store:Store){drop(store);std::fs::remove_dir_all(root).unwrap();}
 #[test]fn checkpoint_reopens_without_model_or_dispatch(){let(root,store,p)=fixture();store.save_research_plan(&p,0).unwrap();store.record_research_sweep(&report(&p,"one")).unwrap();drop(store);let store=Store::open(&root.join("state")).unwrap();let cp=store.research_checkpoint(p["taskId"].as_str().unwrap(),None).unwrap();assert_eq!(cp["reports"].as_array().unwrap().len(),1);assert_eq!(cp["plan"]["originalGoal"],p["originalGoal"]);cleanup(root,store);}
 #[test]fn late_goal_keeps_old_evidence(){let(root,store,p)=fixture();let task=p["taskId"].as_str().unwrap();store.revise_task(task,1,"New owner goal").unwrap();store.save_research_plan(&p,0).unwrap();let cp=store.record_research_sweep(&report(&p,"one")).unwrap();assert_eq!(cp["status"],"blocked");assert_eq!(cp["plan"]["goalRevision"],1);assert!(store.assert_research_admission(task,p["investigationId"].as_str().unwrap(),1).is_err());cleanup(root,store);}
 #[test]fn new_session_does_not_reset_sweep_loop(){let(root,store,p)=fixture();let task=p["taskId"].as_str().unwrap();store.save_research_plan(&p,0).unwrap();for i in 0..4{store.record_research_sweep(&report(&p,&format!("s_{i}"))).unwrap();}store.new_executor_session(task,"another",None).unwrap();assert_eq!(store.task(task).unwrap()["progress"]["noProgress"],3);assert!(store.assert_research_admission(task,p["investigationId"].as_str().unwrap(),1).is_err());cleanup(root,store);}
 #[test]fn repeated_report_is_not_another_cycle(){let(root,store,p)=fixture();store.save_research_plan(&p,0).unwrap();let r=report(&p,"one");let first=store.record_research_sweep(&r).unwrap();assert_eq!(first,store.record_research_sweep(&r).unwrap());let mut bad=r;bad["reportSha256"]=json!("c".repeat(64));assert!(store.record_research_sweep(&bad).is_err());cleanup(root,store);}
 #[test]fn renamed_investigation_cannot_raise_task_budget(){let(root,store,p)=fixture();store.save_research_plan(&p,0).unwrap();let mut second=p.clone();second["investigationId"]=json!("second");second["budget"]["maxSweeps"]=json!(32);assert!(store.save_research_plan(&second,0).is_err());cleanup(root,store);}
 #[test]fn host_gap_event_does_not_impersonate_provider(){let(root,store,p)=fixture();store.new_executor_session(p["taskId"].as_str().unwrap(),"session",Some("thread")).unwrap();store.set_session_generation("session","g").unwrap();store.append_host_event("session","g",&json!({"method":"studio/researchGap","params":{"message":"fixture"}})).unwrap();let events=store.session_events("session",0).unwrap();assert_eq!(events["events"][0]["origin"],"host");cleanup(root,store);}
}

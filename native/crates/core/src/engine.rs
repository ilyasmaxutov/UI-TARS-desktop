use crate::{files::{hash,normalized,seal,validate_files,safe_path},graph::compile,model::*};
use std::{collections::BTreeMap,sync::atomic::{AtomicBool,Ordering}};
#[derive(Clone,Debug)]
enum Data { Text(String), Files(Vec<FileData>) }
impl Data {fn text(&self)->Result<&str>{match self{Self::Text(v)=>Ok(v),_=>Err(Error::new("TYPE","Ожидался текст"))}} fn files(&self)->Result<&[FileData]>{match self{Self::Files(v)=>Ok(v),_=>Err(Error::new("TYPE","Ожидались файлы"))}}}
pub fn verify(files:&[FileData],checks:&[Obligation])->Vec<Finding>{
    checks.iter().map(|c|{let selected=files.iter().filter(|f|c.path=="*"||f.path==c.path).collect::<Vec<_>>();let passed=!selected.is_empty()&&selected.iter().all(|f|match c.kind.as_str(){
        "file_exists"=>true,"contains"=>f.content.contains(&c.value),"not_contains"=>!f.content.contains(&c.value),"nonempty"=>!f.content.trim().is_empty(),"normalized"=>normalized(&f.content)==f.content,"valid_json"=>serde_json::from_str::<serde_json::Value>(&f.content).is_ok(),_=>false});
        Finding{obligation_id:c.id.clone(),description:c.description.clone(),passed,detail:if selected.is_empty(){"Ни один файл не соответствует пути".into()}else{format!("{} файл(ов) · {}",selected.len(),if passed{"условие выполнено"}else{"условие не выполнено"})}}
    }).collect()
}
fn replace(text:&str,find:&str,to:&str)->Result<String>{ensure(!find.is_empty(),"PARAM","Пустой поиск")?;let count=text.matches(find).count();let upper=text.len().saturating_add(count.saturating_mul(to.len())).saturating_sub(count.saturating_mul(find.len()));ensure(upper<=MAX_FILE,"LIMIT","Замена превысит размер")?;Ok(text.replace(find,to))}
fn operate(n:&Node,input:&[Data],files:&[FileData],doc:&Document)->Result<Data>{
    let first=||input.first().ok_or_else(||Error::new("INPUT","Нет входных данных"));
    let output=match n.kind.as_str(){
        "source.files"=>Data::Files(files.to_vec()),"source.text"=>Data::Text(n.param("text").into()),
        "files.filter"=>Data::Files(first()?.files()?.iter().filter(|f|f.path.contains(n.param("match"))).cloned().collect()),
        "files.normalize"=>Data::Files(first()?.files()?.iter().map(|f|FileData{path:f.path.clone(),content:normalized(&f.content)}).collect()),
        "files.replace"=>Data::Files(first()?.files()?.iter().map(|f|Ok(FileData{path:f.path.clone(),content:replace(&f.content,n.param("find"),n.param("replace"))?})).collect::<Result<Vec<_>>>()?),
        "text.replace"=>Data::Text(replace(first()?.text()?,n.param("find"),n.param("replace"))?),
        "text.stats"=>{let text=first()?.text()?;Data::Text(serde_json::to_string_pretty(&serde_json::json!({"lines":if text.is_empty(){0}else{text.split('\n').count()},"characters":text.chars().count(),"words":text.split_whitespace().count(),"bytes":text.len()}))?)},
        "files.report"=>{let fs=first()?.files()?;ensure(!fs.is_empty(),"EMPTY","Для отчёта нужен хотя бы один файл")?;let mut lines=vec!["# Отчёт по проекту".to_string(),String::new(),"| Файл | Байт UTF-8 | Строк | SHA-256 |".into(),"|---|---:|---:|---|".into()];
            for f in fs {lines.push(format!("| {} | {} | {} | {} |",f.path.replace('|',"\\|"),f.content.len(),if f.content.is_empty(){0}else{f.content.split('\n').count()},hash(f.content.as_bytes())));}lines.extend([String::new(),format!("Всего файлов: {}",fs.len()),String::new()]);Data::Text(lines.join("\n"))},
        "text.to_file"=>{safe_path(n.param("path"))?;Data::Files(vec![FileData{path:n.param("path").into(),content:first()?.text()?.into()}])},
        "files.merge"=>{ensure(n.param("readPolicy")=="all-once","READ_POLICY","Не задано правило чтения")?;let mut map:BTreeMap<String,FileData>=BTreeMap::new();for i in input {for f in i.files()?{if let Some(old)=map.get(&f.path.to_lowercase()){ensure(old==f,"MERGE_CONFLICT",format!("Конфликт: {}",f.path))?;}map.insert(f.path.to_lowercase(),f.clone());}}Data::Files(map.into_values().collect())},
        "verify.files"=>{let fs=first()?.files()?;let findings=verify(fs,&doc.goal.obligations);ensure(!findings.is_empty()&&findings.iter().all(|f|f.passed),"VERIFICATION",findings.iter().filter(|f|!f.passed).map(|f|f.description.as_str()).collect::<Vec<_>>().join("; "))?;Data::Files(fs.to_vec())},
        "result.files"=>{let fs=first()?.files()?;ensure(!fs.is_empty(),"EMPTY","Пустой результат")?;Data::Files(fs.to_vec())},
        _=>return Err(Error::new("UNAVAILABLE","Нет принятого исполнителя"))
    };
    match &output {Data::Files(fs)=>validate_files(fs)?,Data::Text(text)=>ensure(text.len()<=MAX_FILE,"LIMIT","Результат слишком велик")?};Ok(output)
}
pub fn prepare(doc:&Document,files:&[FileData])->Result<Run>{
    validate_files(files)?;let plan=compile(doc)?;ensure(plan.diagnostics.is_empty(),"PREFLIGHT",plan.diagnostics.iter().map(|d|d.message.as_str()).collect::<Vec<_>>().join("; "))?;
    Ok(Run{id:new_id("run"),document_id:doc.id.clone(),revision:doc.revision,goal_revision:doc.goal.revision,state:"running".into(),started_at:now(),finished_at:None,nodes:plan.order.iter().map(|id|(id.clone(),"queued".into())).collect(),previews:BTreeMap::new(),events:vec![],artifacts:vec![],error:None,profile:"native-builtins".into(),input_hash:hash(serde_json::to_string(&serde_json::to_value(files)?)?.as_bytes()),document_hash:hash(serde_json::to_string(&serde_json::to_value(doc)?)?.as_bytes()),inputs:files.to_vec(),goal:doc.goal.clone(),accepted:false,command_fingerprint:None,cancel_requested:false,acceptance:None})
}
fn event(run:&mut Run,kind:&str,node:Option<&str>,message:String){let seq=run.events.last().map_or(1,|e|e.seq+1);run.events.push(Event{seq,run_id:run.id.clone(),at:now(),kind:kind.into(),node_id:node.map(String::from),message});if run.events.len()>4096{run.events.remove(0);}}
/// Each run executes sequentially here; separate host runs can progress concurrently.
/// No claim of intra-run parallelism or arbitrary executable containment.
pub fn execute(doc:&Document,files:&[FileData],mut run:Run,cancel:&AtomicBool,mut persist:impl FnMut(&Run)->Result<()>)->Result<Run>{
    let plan=compile(doc)?;ensure(plan.diagnostics.is_empty(),"PREFLIGHT","Конструкция не прошла проверку")?;let mut outputs:BTreeMap<String,Data>=BTreeMap::new();let mut retained_output_bytes=0usize;
    event(&mut run,"run.started",None,"Зафиксированы цель, конструкция и входы".into());persist(&run)?;
    let operation=(||->Result<()> {
        for id in plan.order {
            ensure(!cancel.load(Ordering::SeqCst),"CANCELLED","Отменено владельцем")?;let n=doc.nodes.iter().find(|n|n.id==id).ok_or_else(||Error::new("NODE","Нет узла"))?;
            run.nodes.insert(id.clone(),"running".into());event(&mut run,"node.started",Some(&id),n.title.clone());persist(&run)?;
            let mut incoming=doc.edges.iter().filter(|e|e.target==id).collect::<Vec<_>>();incoming.sort_by(|a,b|a.id.cmp(&b.id));
            let inputs=incoming.iter().map(|e|outputs.get(&e.source).cloned().ok_or_else(||Error::new("DEPENDENCY","Нет выхода зависимости"))).collect::<Result<Vec<_>>>()?;
            let output=match operate(n,&inputs,files,doc){Ok(o)=>o,Err(e)=>{run.nodes.insert(id.clone(),"failed".into());event(&mut run,"node.failed",Some(&id),e.to_string());return Err(e);}};
            ensure(!cancel.load(Ordering::SeqCst),"CANCELLED","Отменено владельцем")?;
            retained_output_bytes=retained_output_bytes.saturating_add(match &output{Data::Text(t)=>t.len(),Data::Files(fs)=>fs.iter().map(|f|f.content.len()).sum()});ensure(retained_output_bytes<=64*1024*1024,"WORKING_SET","Логические выходы графа превысили 64 МиБ")?;
            let preview=match &output{Data::Text(t)=>t.chars().take(180).collect::<String>(),Data::Files(fs)=>format!("{} файл(ов) · {} Б",fs.len(),fs.iter().map(|f|f.content.len()).sum::<usize>())};
            if n.kind=="result.files" {let fs=output.files()?;let findings=verify(fs,&doc.goal.obligations);ensure(!findings.is_empty()&&findings.iter().all(|f|f.passed),"VERIFICATION","Повторная проверка результата не пройдена")?;run.artifacts.push(seal(fs,doc,findings)?);}
            outputs.insert(id.clone(),output);run.previews.insert(id.clone(),preview.clone());run.nodes.insert(id.clone(),"completed".into());event(&mut run,"node.completed",Some(&id),preview);persist(&run)?;
        }
        ensure(!run.artifacts.is_empty(),"EMPTY","Нет запечатанного результата")?;ensure(!cancel.load(Ordering::SeqCst),"CANCELLED","Отменено владельцем")?;Ok(())
    })();
    match operation {Ok(())=>{run.state="review".into();event(&mut run,"run.review",None,"Локальные проверки выполнены; требуется решение владельца".into());},Err(e)=>{run.state=(if e.code=="CANCELLED"{"cancelled"}else{"failed"}).into();run.error=Some(e.to_string());run.artifacts.clear();for value in run.nodes.values_mut(){if value=="queued"||value=="running"{*value="cancelled".into();}}let state=run.state.clone();event(&mut run,&format!("run.{state}"),None,e.to_string());}}
    run.finished_at=Some(now());persist(&run)?;Ok(run)
}

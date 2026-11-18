use crate::{files::safe_path,model::*};
use serde::{Serialize,Deserialize};
use std::collections::{BTreeMap,BTreeSet};
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Diagnostic {pub code:String,pub message:String,pub node_id:Option<String>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Plan {pub document_id:String,pub revision:u64,pub order:Vec<String>,pub layers:Vec<Vec<String>>,pub diagnostics:Vec<Diagnostic>}
pub fn ports(kind:&str)->Option<(Option<&'static str>,Option<&'static str>)>{
    Some(match kind {
        "source.files"=>(None,Some("files")),"source.text"=>(None,Some("text")),
        "files.filter"|"files.replace"|"files.normalize"|"files.merge"|"verify.files"|"result.files"|"agent.codex"=>(Some("files"),Some("files")),
        "files.report"=>(Some("files"),Some("text")),"text.replace"|"text.stats"=>(Some("text"),Some("text")),"text.to_file"=>(Some("text"),Some("files")),"note"=>(None,None),_=>return None
    })
}
pub fn validate_document(d:&Document)->Result<()> {
    ensure(d.schema==1&&d.revision>0&&d.goal.revision>0,"SCHEMA","Неподдержанная схема / редакция")?;
    ensure(d.nodes.len()<=500&&d.edges.len()<=1000&&d.goal.obligations.len()<=64,"LIMIT","Превышен предел конструкции")?;
    ensure(d.goal.original.len()<=65536&&d.id.len()<128&&d.project_id.len()<128,"LIMIT","Превышен предел поля")?;
    let mut ids=BTreeSet::new();for n in &d.nodes {ensure(!n.id.is_empty()&&n.id.len()<128&&ids.insert(&n.id)&&ports(&n.kind).is_some(),"SCHEMA","Неизвестная операция / повтор ID")?;
        ensure(n.title.len()<=2048&&serde_json::to_vec(&n.params)?.len()<=MAX_FILE,"LIMIT","Параметры превышают предел")?;
        for (k,v) in &n.params {ensure(!["__proto__","prototype","constructor"].contains(&k.as_str())&&(v.is_string()||v.is_boolean()||v.is_number()),"SCHEMA","Недопустимое значение параметра")?;}
    }
    let mut edges=BTreeSet::new();for e in &d.edges {ensure(edges.insert(&e.id)&&e.source_port=="out"&&e.target_port=="in","SCHEMA","Неверная связь")?;}
    let mut checks=BTreeSet::new();for c in &d.goal.obligations {ensure(checks.insert(&c.id)&&["file_exists","contains","not_contains","valid_json","normalized","nonempty"].contains(&c.kind.as_str()),"SCHEMA","Неверный критерий")?;if c.path!="*"{safe_path(&c.path)?;}if c.kind=="contains"||c.kind=="not_contains"{ensure(!c.value.is_empty(),"CRITERION","Пустой критерий")?;}}
    ensure(!d.workspaces.is_empty()&&d.workspaces.len()<=32,"SCHEMA","Неверные пространства")?;
    // Geometry is not authoritative for execution. Validate its shape before persistence.
    for w in &d.workspaces {let sheets=w.get("sheets").and_then(|v|v.as_array()).ok_or_else(||Error::new("SCHEMA","Нет листов"))?;ensure(!sheets.is_empty()&&sheets.len()<=64,"LIMIT","Неверное число листов")?;
        for s in sheets {let views=s.get("views").and_then(|v|v.as_array()).ok_or_else(||Error::new("SCHEMA","Нет представлений"))?;ensure(views.len()<=500,"LIMIT","Слишком много представлений")?;
            for v in views {ensure(v.get("nodeId").and_then(|v|v.as_str()).map(|id|d.nodes.iter().any(|n|n.id==id)).unwrap_or(false),"SCHEMA","Вид отсутствующего узла")?;}
        }
    }Ok(())
}
pub fn compile(d:&Document)->Result<Plan>{
    validate_document(d)?;let active=d.nodes.iter().filter(|n|n.kind!="note").collect::<Vec<_>>();let nodes=active.iter().map(|n|(n.id.as_str(),*n)).collect::<BTreeMap<_,_>>();
    let mut degree=active.iter().map(|n|(n.id.clone(),0usize)).collect::<BTreeMap<_,_>>();let mut diagnostics=vec![];
    let mut problem=|code:&str,message:&str,node:Option<&str>|diagnostics.push(Diagnostic{code:code.into(),message:message.into(),node_id:node.map(String::from)});
    let mut pairs=BTreeSet::new();for e in &d.edges {let (Some(a),Some(b))=(nodes.get(e.source.as_str()),nodes.get(e.target.as_str())) else {problem("MISSING_NODE","Связь указывает на отсутствующий узел",None);continue;};
        if !pairs.insert((&e.source,&e.target)){problem("DUPLICATE_LINK","Повтор связи",Some(&e.target));}
        if let (Some((_,out)),Some((input,_)))=(ports(&a.kind),ports(&b.kind)) {if out.is_none()||out!=input{problem("TYPE","Несовместимые типы портов",Some(&e.target));}}
        *degree.get_mut(&e.target).expect("validated target")+=1;
    }
    for n in &active {let (input,_)=ports(&n.kind).expect("validated operation");let count=degree[&n.id];
        if n.kind=="agent.codex"{problem("UNAVAILABLE","Codex заблокирован до приёмки изоляции и адаптера",Some(&n.id));}
        if input.is_some()&&count==0{problem("INPUT","Обязательный вход не подключён",Some(&n.id));}
        if input.is_none()&&count>0{problem("UNEXPECTED_INPUT","У источника нет входа",Some(&n.id));}
        if count>1&&(n.kind!="files.merge"||n.param("readPolicy")!="all-once"){problem("READ_POLICY","Требуется явное правило all-once",Some(&n.id));}
        if n.kind=="text.to_file"&&safe_path(n.param("path")).is_err(){problem("PATH","Неверный путь результата",Some(&n.id));}
        if ["text.replace","files.replace"].contains(&n.kind.as_str())&&n.param("find").is_empty(){problem("PARAM","Пустая строка поиска",Some(&n.id));}
        if n.kind=="verify.files"&&d.goal.obligations.is_empty(){problem("CRITERIA","Нет обязательств цели",Some(&n.id));}
        if n.kind=="result.files"&&d.edges.iter().filter(|e|e.target==n.id).any(|e|nodes.get(e.source.as_str()).is_none_or(|x|x.kind!="verify.files")){problem("UNVERIFIED_RESULT","Результат должен идти непосредственно от проверки",Some(&n.id));}
    }
    if !active.iter().any(|n|n.kind=="result.files"){problem("NO_RESULT","Нет результата",None);}
    let mut pending=active.iter().map(|n|n.id.clone()).collect::<BTreeSet<_>>();let mut layers=vec![];let mut order=vec![];
    while !pending.is_empty(){let ready=pending.iter().filter(|id|degree[*id]==0).cloned().collect::<Vec<_>>();if ready.is_empty(){problem("CYCLE","Цикл не поддерживается этим инкрементом",None);break;}
        for id in &ready {pending.remove(id);order.push(id.clone());for e in d.edges.iter().filter(|e|e.source==*id){if let Some(value)=degree.get_mut(&e.target){*value=value.saturating_sub(1);}}}layers.push(ready);
    }
    let mut useful=active.iter().filter(|n|n.kind=="result.files").map(|n|n.id.clone()).collect::<BTreeSet<_>>();loop {let before=useful.len();for e in &d.edges {if useful.contains(&e.target){useful.insert(e.source.clone());}}if useful.len()==before{break;}}
    for n in &active {if !useful.contains(&n.id){problem("UNUSED","Ветка не ведёт к результату",Some(&n.id));}}
    Ok(Plan{document_id:d.id.clone(),revision:d.revision,order,layers,diagnostics})
}

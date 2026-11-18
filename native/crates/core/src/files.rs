use crate::model::*;
use sha2::{Digest,Sha256};
use std::{collections::BTreeSet,fs::{self,File,OpenOptions},io::{Read,Write},path::Path};
pub fn hash(data:&[u8])->String { format!("{:x}",Sha256::digest(data)) }
pub fn safe_path(path:&str)->Result<()> {
    ensure(!path.is_empty()&&path.chars().count()<=240,"PATH","Недопустимая длина пути")?;
    ensure(!path.starts_with('/')&&!path.chars().any(|c|c<' '||"\\:<>\"|?*".contains(c)),"PATH","Недопустимые символы пути")?;
    for part in path.split('/') {
        ensure(!part.is_empty()&&part!="."&&part!=".."&&!part.ends_with('.')&&!part.ends_with(' '),"PATH","Недопустимый сегмент")?;
        let first=part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved=["CON","PRN","AUX","NUL"].contains(&first.as_str())||(first.len()==4&&(first.starts_with("COM")||first.starts_with("LPT"))&&matches!(first.as_bytes()[3],b'1'..=b'9'));
        ensure(!reserved,"PATH","Зарезервированное имя Windows")?;
    } Ok(())
}
pub fn validate_files(files:&[FileData])->Result<()> {
    ensure(files.len()<=MAX_FILES,"LIMIT","Слишком много файлов")?;let mut seen=BTreeSet::new();let mut total=0usize;
    for f in files { safe_path(&f.path)?;ensure(seen.insert(f.path.to_lowercase()),"PATH_COLLISION","Повтор пути")?;
        ensure(!f.content.contains('\0'),"FORMAT","Только UTF-8 текст без NUL")?;
        ensure(f.content.len()<=MAX_FILE,"LIMIT",format!("Файл превышает предел: {}",f.path))?;total=total.saturating_add(f.content.len());
    } ensure(total<=MAX_TOTAL,"LIMIT","Набор превышает 8 МиБ")
}
fn ordinary(path:&Path)->Result<fs::Metadata> {
    let m=fs::symlink_metadata(path)?;ensure(!m.file_type().is_symlink(),"LINK","Символические ссылки запрещены")?;
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt;ensure(m.file_attributes()&0x400==0,"REPARSE","Reparse point не поддерживается")?; }
    Ok(m)
}
/// Trusted local import only. This is not claimed to resist hostile reparse races.
/// No hidden skipped directories; unsupported entries fail the whole import.
pub fn import_folder(root:&Path)->Result<Vec<FileData>> {
    ensure(ordinary(root)?.is_dir(),"ROOT","Нужна обычная папка")?;let mut result=vec![];let mut total=0usize;
    fn visit(root:&Path,dir:&Path,out:&mut Vec<FileData>,total:&mut usize,depth:usize)->Result<()> {
        ensure(depth<=32,"DEPTH","Слишком глубокое дерево")?;
        let mut entries=fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;entries.sort_by_key(|e|e.file_name());
        for entry in entries {let path=entry.path();let before=ordinary(&path)?;
            if before.is_dir(){visit(root,&path,out,total,depth+1)?;continue;}
            ensure(before.is_file(),"FORMAT","Специальные объекты не поддерживаются")?;
            ensure(out.len()<MAX_FILES&&before.len()<=MAX_FILE as u64,"LIMIT","Превышен предел импорта")?;
            let relative=path.strip_prefix(root).map_err(|_|Error::new("PATH","Выход за корень"))?.to_string_lossy().replace('\\',"/");safe_path(&relative)?;
            let mut data=Vec::new();File::open(&path)?.take((MAX_FILE+1) as u64).read_to_end(&mut data)?;
            ensure(data.len()<=MAX_FILE,"LIMIT","Файл вырос при чтении")?;let after=ordinary(&path)?;
            ensure(before.len()==after.len()&&before.modified().ok()==after.modified().ok(),"SOURCE_CHANGED","Источник изменился при чтении")?;
            *total=total.saturating_add(data.len());ensure(*total<=MAX_TOTAL,"LIMIT","Набор превышает 8 МиБ")?;
            let content=String::from_utf8(data).map_err(|_|Error::new("UTF8",format!("Не текст UTF-8: {relative}")))?;out.push(FileData{path:relative,content});
        }Ok(())
    }
    visit(root,root,&mut result,&mut total,0)?;validate_files(&result)?;Ok(result)
}
pub fn normalized(s:&str)->String {let s=s.replace("\r\n","\n").replace('\r',"\n");let result=s.split('\n').map(|s|s.trim_end_matches([' ','\t'])).collect::<Vec<_>>().join("\n");format!("{}\n",result.trim_end_matches('\n'))}
pub fn seal(files:&[FileData],doc:&Document,findings:Vec<Finding>)->Result<Artifact>{
    validate_files(files)?;let mut sorted=files.to_vec();sorted.sort_by(|a,b|a.path.encode_utf16().cmp(b.path.encode_utf16()));
    let manifest=sorted.iter().map(|f|ManifestEntry{path:f.path.clone(),hash:hash(f.content.as_bytes()),bytes:f.content.len()}).collect::<Vec<_>>();
    let payload=serde_json::json!({"manifest":manifest,"goalRevision":doc.goal.revision,"graphRevision":doc.revision});
    let digest=hash(serde_json::to_string(&payload)?.as_bytes());
    Ok(Artifact{id:format!("sha256:{digest}"),files:files.to_vec(),manifest,hash:digest,goal_revision:doc.goal.revision,graph_revision:doc.revision,findings})
}
pub fn artifact_valid(a:&Artifact)->Result<bool>{
    validate_files(&a.files)?;let mut sorted=a.files.clone();sorted.sort_by(|a,b|a.path.encode_utf16().cmp(b.path.encode_utf16()));
    let actual=sorted.iter().map(|f|ManifestEntry{path:f.path.clone(),hash:hash(f.content.as_bytes()),bytes:f.content.len()}).collect::<Vec<_>>();
    let value=serde_json::json!({"manifest":actual,"goalRevision":a.goal_revision,"graphRevision":a.graph_revision});
    Ok(a.id==format!("sha256:{}",a.hash)&&serde_json::to_value(actual)?==serde_json::to_value(&a.manifest)?&&hash(serde_json::to_string(&value)?.as_bytes())==a.hash)
}
/// Creates a NEW proposal directory; never writes back to the source directory.
/// A partial export is not marked published and is left for diagnosis.
pub fn export_proposal(parent:&Path,artifact:&Artifact)->Result<std::path::PathBuf>{
    ensure(artifact_valid(artifact)?,"ARTIFACT","Нарушена целостность результата")?;ensure(!artifact.files.iter().any(|f|f.path==".studio-manifest.json"),"PATH","Зарезервированное имя манифеста")?;
    let destination=parent.join(new_id("proposal"));fs::create_dir(&destination)?;
    for item in &artifact.files {safe_path(&item.path)?;let target=destination.join(&item.path);if let Some(p)=target.parent(){fs::create_dir_all(p)?;}
        let mut f=OpenOptions::new().write(true).create_new(true).open(&target)?;f.write_all(item.content.as_bytes())?;f.sync_all()?;
        ensure(hash(&fs::read(&target)?)==hash(item.content.as_bytes()),"READBACK","Записанное содержимое не совпало")?;
    }
    let manifest=destination.join(".studio-manifest.json");let mut f=OpenOptions::new().write(true).create_new(true).open(manifest)?;f.write_all(serde_json::to_vec_pretty(artifact)?.as_slice())?;f.sync_all()?;Ok(destination)
}

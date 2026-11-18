//! Exact-result reinspection. The caller, not the worker, owns acceptance.
use crate::{engine, files, graph, model::*};
use serde_json::json;

pub fn binding(run: &Run) -> Result<String> {
    let value = json!({"schema":1,"runId":run.id,"documentId":run.document_id,
        "documentHash":run.document_hash,"inputHash":run.input_hash,"commandFingerprint":run.command_fingerprint,
        "graphRevision":run.revision,"goalRevision":run.goal_revision,
        "goal":run.goal,"artifactHashes":run.artifacts.iter().map(|a|&a.hash).collect::<Vec<_>>()});
    Ok(files::hash(serde_json::to_string(&value)?.as_bytes()))
}
pub fn inspect(run: &Run, doc: &Document, inputs: &[FileData]) -> Result<String> {
    graph::validate_document(doc)?;
    ensure(run.state == "review" && !run.cancel_requested, "STATE", "Нет допуска к принятию")?;
    ensure(run.document_id == doc.id && run.revision == doc.revision && run.goal_revision == doc.goal.revision,
        "RUN_BINDING", "Результат принадлежит другой редакции")?;
    ensure(serde_json::to_value(&run.goal)? == serde_json::to_value(&doc.goal)? && run.inputs == inputs,
        "RUN_BINDING", "Цель или исходные данные изменены")?;
    // Current format uses sorted JSON keys. Legacy v0.1 remains inspectable only against stored immutable spec.
    let canonical_doc = files::hash(serde_json::to_string(&serde_json::to_value(doc)?)?.as_bytes());
    let legacy_doc = files::hash(serde_json::to_vec(doc)?.as_slice());
    let canonical_inputs = files::hash(serde_json::to_string(&serde_json::to_value(inputs)?)?.as_bytes());
    let legacy_inputs = files::hash(serde_json::to_vec(inputs)?.as_slice());
    ensure((run.document_hash == canonical_doc || run.document_hash == legacy_doc)
        && (run.input_hash == canonical_inputs || run.input_hash == legacy_inputs), "RUN_BINDING", "Отпечаток не соответствует спецификации")?;
    ensure(!run.nodes.is_empty() && run.nodes.values().all(|s| s == "completed"), "INCOMPLETE", "Не все операции завершены")?;
    let expected_nodes: std::collections::BTreeSet<_> = doc.nodes.iter().filter(|n|n.kind != "note").map(|n|n.id.as_str()).collect();
    let actual_nodes: std::collections::BTreeSet<_> = run.nodes.keys().map(|id|id.as_str()).collect();
    ensure(actual_nodes == expected_nodes, "INCOMPLETE", "Набор завершённых операций изменён")?;
    let count = doc.nodes.iter().filter(|n| n.kind == "result.files").count();
    ensure(count > 0 && run.artifacts.len() == count, "ARTIFACT_COUNT", "Предъявлены не все конечные результаты")?;
    for artifact in &run.artifacts {
        ensure(!artifact.files.is_empty() && artifact.goal_revision == doc.goal.revision
            && artifact.graph_revision == doc.revision && files::artifact_valid(artifact)?,
            "ARTIFACT_BINDING", "Содержимое или редакция артефакта не совпадает")?;
        let checks = engine::verify(&artifact.files, &doc.goal.obligations);
        ensure(!checks.is_empty() && checks.iter().all(|f| f.passed), "VERIFICATION", "Повторная проверка критерия не пройдена")?;
    }
    binding(run)
}

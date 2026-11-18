// A native stdio fixture, compiled by the transport tests. No model, network,
// command execution, or production configuration is involved.
use std::{fs::OpenOptions, io::{self, BufRead, Write}, thread, time::Duration};

// The host writes compact serde JSON and generates ASCII RPC IDs. This fixture
// intentionally implements only that narrow input shape; it is not a parser.
fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("\"{name}\":\"");
    line.split_once(&prefix)?.1.split_once('"').map(|part| part.0)
}

fn emit(frame: &str, split: bool) {
    let mut out = io::stdout().lock();
    let bytes = format!("{frame}\n").into_bytes();
    if split {
        // Splits inside multibyte UTF-8 as well as between JSON tokens.
        for chunk in bytes.chunks(3) {
            out.write_all(chunk).unwrap(); out.flush().unwrap();
            thread::sleep(Duration::from_millis(1));
        }
    } else { out.write_all(&bytes).unwrap(); out.flush().unwrap(); }
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1).expect("mode");
    let mut log = OpenOptions::new().create_new(true).write(true).open(args.get(2).expect("wire log")).unwrap();
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        writeln!(log, "{line}").unwrap(); log.flush().unwrap();
        let Some(id) = field(&line, "id") else { continue };
        match field(&line, "method") {
            Some("initialize") => emit(&format!(r#"{{"id":"{id}","result":{{"userAgent":"native-stdio-fixture"}}}}"#), mode == "split"),
            Some("turn/start") => {
                if mode == "exit" { return; }
                if mode == "late_ack" { thread::sleep(Duration::from_millis(250)); }
                if mode == "complete_before_ack" {
                    emit(r#"{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"remote_turn","status":"inProgress","items":[]}}}"#, false);
                    emit(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"remote_turn","status":"completed","items":[]}}}"#, false);
                }
                emit(&format!(r#"{{"id":"{id}","result":{{"turn":{{"id":"remote_turn","status":"inProgress","items":[]}}}}}}"#), mode == "split");
            }
            Some("thread/read") => emit(&format!(r#"{{"id":"{id}","result":{{"thread":{{"id":"thread","preview":"ответ по частям","status":{{"type":"idle"}},"turns":[]}}}}}}"#), mode == "split"),
            Some("thread/start") | Some("thread/resume") => emit(&format!(r#"{{"id":"{id}","result":{{"thread":{{"id":"thread","status":{{"type":"idle"}},"turns":[]}}}}}}"#), false),
            Some("thread/turns/list") if mode == "unmaterialized" => emit(&format!(r#"{{"id":"{id}","error":{{"code":-32600,"message":"thread thread is not materialized yet; thread/turns/list is unavailable before first user message"}}}}"#), false),
            Some("thread/turns/list") if mode == "history_error" => emit(&format!(r#"{{"id":"{id}","error":{{"code":-32600,"message":"History backend is unavailable"}}}}"#), false),
            Some("thread/turns/list") => emit(&format!(r#"{{"id":"{id}","result":{{"data":[]}}}}"#), false),
            _ => emit(&format!(r#"{{"id":"{id}","error":{{"code":-32601,"message":"fixture method unavailable"}}}}"#), false),
        }
    }
}

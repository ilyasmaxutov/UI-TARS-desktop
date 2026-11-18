fn main() {
 if std::env::args().nth(1).as_deref() == Some("--selftest") {
  match studio_host::selftest::run() {
   Ok(report) => { println!("{}", report); return; },
   Err(error) => { eprintln!("{}: {}", error.code, error.message); std::process::exit(1); }
  }
 }
 if std::env::args().len() > 1 { eprintln!("Usage: studio-host [--selftest]"); std::process::exit(2); }

 #[cfg(windows)] {let result=studio_host::data_root().and_then(|root|studio_host::windows::serve(&root));if let Err(e)=result{eprintln!("{}: {}",e.code,e.message);std::process::exit(1);}}
 #[cfg(not(windows))] {eprintln!("studio-host: Windows 11 only. Portable core tests do not establish Windows isolation.");std::process::exit(2);}
}

use std::env;
use std::io::{self, BufReader};
use std::path::PathBuf;
use std::process;

fn main() {
    let event_log_path = env::args().nth(1).map(PathBuf::from);
    let stdin = io::stdin();
    let stdout = io::stdout();
    match lody_scripted_acp::run_stdio_loop(BufReader::new(stdin), stdout, event_log_path) {
        Ok(code) => process::exit(code),
        Err(err) => {
            eprintln!("lody-scripted-acp fatal I/O error: {err}");
            process::exit(2);
        }
    }
}

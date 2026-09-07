use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Reply {
    #[serde(rename = "type")]
    kind: String,
    id: Option<u64>,
    text: Option<String>,
    message: Option<String>,
}

/// One loaded audio.cpp model per recording session. Requests are serialized
/// by the ASR worker; dropping the owner terminates and reaps the helper.
pub(super) struct FunasrSession {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<Result<Reply, String>>,
    next_id: u64,
    failed: bool,
}

impl FunasrSession {
    pub fn start(helper: &Path, model: &Path, backend: &str) -> Result<Self, String> {
        let mut command = Command::new(helper);
        command
            .args(["--task", "asr", "--family", "fun_asr_nano", "--model"])
            .arg(model)
            .args(["--backend", backend, "--speech-kit-session"]);
        Self::spawn(&mut command, Duration::from_secs(60))
    }

    fn spawn(command: &mut Command, timeout: Duration) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("start persistent FunASR helper: {e}"))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, replies) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                let result = match reader.by_ref().take(65_537).read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) if line.len() > 65_536 || !line.ends_with('\n') => {
                        Err("FunASR response exceeds protocol limit".to_string())
                    }
                    Ok(_) => serde_json::from_str(&line)
                        .map_err(|e| format!("invalid FunASR response: {e}")),
                    Err(e) => Err(format!("read FunASR response: {e}")),
                };
                let failed = result.is_err();
                if tx.send(result).is_err() || failed {
                    break;
                }
            }
        });
        let mut session = Self {
            child,
            stdin,
            replies,
            next_id: 0,
            failed: false,
        };
        let reply = session.receive(timeout)?;
        if reply.kind != "ready" {
            return Err(reply
                .message
                .unwrap_or_else(|| "FunASR helper did not become ready".into()));
        }
        Ok(session)
    }

    fn receive(&mut self, timeout: Duration) -> Result<Reply, String> {
        let result = self
            .replies
            .recv_timeout(timeout)
            .map_err(|e| format!("FunASR session unavailable: {e}"))
            .and_then(|reply| reply);
        if result.is_err() {
            self.stop();
        }
        result
    }

    pub fn transcribe(
        &mut self,
        audio: &Path,
        language: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        if self.failed {
            return Err("FunASR session failed; start a new recording to reload the model".into());
        }
        self.next_id += 1;
        let request = serde_json::json!({"id": self.next_id, "audio": audio, "language": language});
        let result = (|| {
            serde_json::to_writer(&mut self.stdin, &request).map_err(|e| e.to_string())?;
            self.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
            self.stdin.flush().map_err(|e| e.to_string())?;
            let reply = self.receive(timeout)?;
            if reply.id != Some(self.next_id) {
                return Err("FunASR response ID mismatch".into());
            }
            if reply.kind != "result" {
                return Err(reply
                    .message
                    .unwrap_or_else(|| "FunASR request failed".into()));
            }
            reply
                .text
                .ok_or_else(|| "FunASR response missing text".into())
        })();
        if result.is_err() {
            self.stop();
        }
        result
    }

    fn stop(&mut self) {
        self.failed = true;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for FunasrSession {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn reuses_process_for_requests_and_reaps_on_drop() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "printf '{\"type\":\"ready\"}\\n'; i=0; while read -r line; do i=$((i+1)); printf '{\"type\":\"result\",\"id\":%s,\"text\":\"ok\"}\\n' \"$i\"; done"]);
        let mut session = FunasrSession::spawn(&mut cmd, Duration::from_secs(1)).unwrap();
        let pid = session.child.id();
        for _ in 0..3 {
            assert_eq!(
                session
                    .transcribe(Path::new("audio.wav"), "en", Duration::from_secs(1))
                    .unwrap(),
                "ok"
            );
        }
        assert_eq!(session.child.id(), pid);
        session.stop();
        assert!(session.child.try_wait().unwrap().is_some());
        assert!(
            session
                .transcribe(Path::new("audio.wav"), "en", Duration::from_secs(1))
                .is_err()
        );
    }

    #[test]
    fn startup_timeout_reaps_helper() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "exec sleep 30"]);
        let start = std::time::Instant::now();
        assert!(FunasrSession::spawn(&mut cmd, Duration::from_millis(30)).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn request_timeout_reaps_helper_without_reloading() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "printf '{\"type\":\"ready\"}\\n'; exec sleep 30"]);
        let mut session = FunasrSession::spawn(&mut cmd, Duration::from_secs(1)).unwrap();
        assert!(
            session
                .transcribe(Path::new("audio.wav"), "en", Duration::from_millis(30))
                .is_err()
        );
        assert!(session.child.try_wait().unwrap().is_some());
        assert!(session.failed);
    }

    #[test]
    fn mismatched_revision_is_rejected() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "printf '{\"type\":\"ready\"}\\n'; read -r line; printf '{\"type\":\"result\",\"id\":99,\"text\":\"wrong\"}\\n'"]);
        let mut session = FunasrSession::spawn(&mut cmd, Duration::from_secs(1)).unwrap();
        assert!(
            session
                .transcribe(Path::new("audio.wav"), "en", Duration::from_secs(1))
                .unwrap_err()
                .contains("ID mismatch")
        );
        assert!(session.child.try_wait().unwrap().is_some());
    }
}

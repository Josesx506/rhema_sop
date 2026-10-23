//! Local Bark STT provider (macOS only).
//!
//! Runs Underdog Bark 3.0 through the `bark-sidecar` Swift process, which
//! loads the Core ML model with `FluidAudio` and transcribes on the Apple
//! Neural Engine. Audio is segmented with the same VAD loop as the Whisper
//! provider (see [`crate::segmenter`]); each speech segment is written to the
//! sidecar's stdin as a binary frame and the transcript comes back as one
//! JSON line on stdout. Emits the same [`TranscriptEvent`] types as the other
//! providers.
//!
//! # Protocol
//!
//! stdin (binary, little-endian, repeated): `u32 segment_id`, `u32 n_samples`,
//! then `n_samples` `f32` samples at 16 kHz mono in `[-1, 1]`. A frame with
//! `n_samples == 0` asks the sidecar to shut down.
//!
//! stdout (one JSON object per line):
//!
//! ```json
//! {"type":"ready","load_ms":1234}
//! {"type":"result","id":7,"text":"...","confidence":0.96,"elapsed_ms":85,"tokens":[{"text":"John","start":0.31,"end":0.52,"confidence":0.97}]}
//! {"type":"error","id":7,"message":"..."}
//! ```
//!
//! `tokens` is optional and already word-level. Lines with an unknown `type`
//! are ignored with a warning. The sidecar logs to stderr, which this module
//! forwards to the app log.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use crate::error::SttError;
use crate::provider::SttProvider;
use crate::segmenter::{self, i16_to_f32};
use crate::types::{TranscriptEvent, Word};

/// Log prefix shared by every line this provider writes.
const LOG: &str = "[BARK]";

/// Audio sample rate the sidecar expects.
const SAMPLE_RATE_HZ: f64 = 16_000.0;

/// How long to wait for the sidecar to report `ready`. The first launch
/// compiles the encoder for the Neural Engine, which can take minutes.
const READY_TIMEOUT: Duration = Duration::from_mins(5);

/// How long to wait for one segment's result before treating the sidecar as
/// hung. Real inference takes well under a second.
const SEGMENT_TIMEOUT: Duration = Duration::from_secs(30);

/// After `stop()`, how much longer an in-flight segment may take before the
/// sidecar is treated as hung. Short so a stuck Core ML call cannot keep the
/// provider, the process and its model memory alive after the user stopped.
const STOP_GRACE: Duration = Duration::from_secs(3);

/// How often the inference loop checks the cancel flag while it waits.
const CANCEL_POLL: Duration = Duration::from_millis(100);

/// Grace period after the shutdown frame before the sidecar is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

// ── Protocol types ───────────────────────────────────────────────────────

/// One word from a `result` line (the sidecar has already grouped subwords).
#[derive(Debug, Clone, PartialEq, Deserialize)]
struct SidecarToken {
    text: String,
    start: f64,
    end: f64,
    confidence: f64,
}

/// A `result` line.
#[derive(Debug, Clone, PartialEq, Deserialize)]
struct SidecarResult {
    id: u32,
    text: String,
    #[serde(default)]
    confidence: f64,
    #[serde(default)]
    elapsed_ms: u64,
    #[serde(default)]
    tokens: Option<Vec<SidecarToken>>,
}

#[derive(Debug, Deserialize)]
struct ReadyLine {
    #[serde(default)]
    load_ms: u64,
}

#[derive(Debug, Deserialize)]
struct ErrorLine {
    #[serde(default)]
    id: u32,
    message: String,
}

/// A parsed stdout line from the sidecar.
#[derive(Debug, Clone, PartialEq)]
enum SidecarLine {
    Ready {
        load_ms: u64,
    },
    Result(SidecarResult),
    Error {
        id: u32,
        message: String,
    },
    /// A `type` this provider does not know. Ignored with a warning so a
    /// newer sidecar can add line kinds without breaking older app builds.
    Unknown(String),
}

/// Parse one stdout line. Malformed JSON and lines without a string `type`
/// are [`SttError::ParseError`]; unknown types are [`SidecarLine::Unknown`].
fn parse_line(line: &str) -> Result<SidecarLine, SttError> {
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| SttError::ParseError(format!("invalid sidecar JSON: {e}")))?;
    let kind = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| SttError::ParseError("sidecar line has no \"type\" field".to_string()))?;

    let parsed = match kind {
        "ready" => {
            let ready: ReadyLine = serde_json::from_value(value.clone())
                .map_err(|e| SttError::ParseError(format!("bad ready line: {e}")))?;
            SidecarLine::Ready {
                load_ms: ready.load_ms,
            }
        }
        "result" => {
            let result: SidecarResult = serde_json::from_value(value.clone())
                .map_err(|e| SttError::ParseError(format!("bad result line: {e}")))?;
            SidecarLine::Result(result)
        }
        "error" => {
            let error: ErrorLine = serde_json::from_value(value.clone())
                .map_err(|e| SttError::ParseError(format!("bad error line: {e}")))?;
            SidecarLine::Error {
                id: error.id,
                message: error.message,
            }
        }
        other => SidecarLine::Unknown(other.to_string()),
    };
    Ok(parsed)
}

/// Encode one stdin frame: `segment_id`, `n_samples`, then the samples, all
/// little-endian. An empty slice yields the zero-length shutdown frame.
#[expect(
    clippy::cast_possible_truncation,
    reason = "segments are capped at MAX_BUFFER_SAMPLES, far below u32::MAX"
)]
fn encode_frame(segment_id: u32, samples: &[f32]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(8 + samples.len() * 4);
    frame.extend_from_slice(&segment_id.to_le_bytes());
    frame.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    for sample in samples {
        frame.extend_from_slice(&sample.to_le_bytes());
    }
    frame
}

// ── Word mapping ─────────────────────────────────────────────────────────

/// Map sidecar word timings to [`Word`]s: lowercase `text`, original in
/// `punctuated_word`, timestamps as given.
fn words_from_tokens(tokens: &[SidecarToken]) -> Vec<Word> {
    tokens
        .iter()
        .map(|t| Word {
            text: t.text.to_lowercase(),
            start: t.start,
            end: t.end,
            confidence: t.confidence,
            punctuated_word: Some(t.text.clone()),
        })
        .collect()
}

/// Spread the words of `text` evenly across `[0, duration_s]`, the same
/// fallback Whisper uses when no word timings are available.
#[expect(clippy::cast_precision_loss, reason = "word counts are small enough")]
fn evenly_spaced_words(text: &str, duration_s: f64, confidence: f64) -> Vec<Word> {
    let n_words = text.split_whitespace().count();
    if n_words == 0 {
        return Vec::new();
    }
    let duration_per_word = duration_s / n_words as f64;
    text.split_whitespace()
        .enumerate()
        .map(|(i, word_text)| {
            let start = i as f64 * duration_per_word;
            Word {
                text: word_text.to_lowercase(),
                start,
                end: start + duration_per_word,
                confidence,
                punctuated_word: Some(word_text.to_string()),
            }
        })
        .collect()
}

/// Build the word list for a result, preferring the sidecar's timings.
fn build_words(result: &SidecarResult, audio_duration_s: f64) -> Vec<Word> {
    match result.tokens.as_deref() {
        Some(tokens) if !tokens.is_empty() => words_from_tokens(tokens),
        _ => evenly_spaced_words(&result.text, audio_duration_s, result.confidence),
    }
}

// ── Sidecar process ──────────────────────────────────────────────────────

/// What the sidecar said about one segment.
enum SegmentOutcome {
    Transcribed(SidecarResult),
    /// The sidecar reported an `error` line for this segment; the session
    /// continues.
    Failed(String),
}

/// A running sidecar process with its protocol pipes.
struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
}

impl Sidecar {
    fn spawn(sidecar_path: &Path, model_dir: &Path) -> Result<Self, SttError> {
        let mut child = Command::new(sidecar_path)
            .arg("--model-dir")
            .arg(model_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                SttError::SidecarFailed(format!("failed to spawn {}: {e}", sidecar_path.display()))
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SttError::SidecarFailed("sidecar stdin was not captured".to_string()))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            SttError::SidecarFailed("sidecar stdout was not captured".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            SttError::SidecarFailed("sidecar stderr was not captured".to_string())
        })?;

        tokio::spawn(forward_stderr(stderr));

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
        })
    }

    /// Read the next meaningful protocol line, skipping blank, malformed and
    /// unknown lines with a warning. `Ok(None)` means the sidecar closed its
    /// stdout, which only happens when it exits.
    async fn next_line(&mut self) -> Result<Option<SidecarLine>, SttError> {
        loop {
            let line = self.stdout.next_line().await.map_err(|e| {
                SttError::SidecarFailed(format!("failed to read from sidecar: {e}"))
            })?;
            let Some(line) = line else {
                return Ok(None);
            };
            if line.trim().is_empty() {
                continue;
            }
            match parse_line(&line) {
                Ok(SidecarLine::Unknown(kind)) => {
                    log::warn!("{LOG} Ignoring sidecar line with unknown type \"{kind}\"");
                }
                Ok(parsed) => return Ok(Some(parsed)),
                Err(e) => {
                    log::warn!("{LOG} Ignoring malformed sidecar line ({e}): {line}");
                }
            }
        }
    }

    /// Block until the sidecar reports `ready`, returning its load time.
    async fn wait_ready(&mut self) -> Result<u64, SttError> {
        loop {
            match self.next_line().await? {
                None => {
                    return Err(SttError::SidecarFailed(
                        "sidecar exited before reporting ready".to_string(),
                    ));
                }
                Some(SidecarLine::Ready { load_ms }) => return Ok(load_ms),
                Some(SidecarLine::Error { message, .. }) => {
                    return Err(SttError::SidecarFailed(message));
                }
                Some(SidecarLine::Result(result)) => {
                    log::warn!(
                        "{LOG} Ignoring result for segment {} before ready",
                        result.id
                    );
                }
                Some(SidecarLine::Unknown(_)) => {}
            }
        }
    }

    /// Send one segment and wait for its matching `result` or `error` line.
    /// `Err` means the sidecar is gone or hung and the session must end.
    async fn transcribe(&mut self, id: u32, samples: &[f32]) -> Result<SegmentOutcome, SttError> {
        let frame = encode_frame(id, samples);
        self.stdin
            .write_all(&frame)
            .await
            .map_err(|e| SttError::SidecarFailed(format!("failed to write segment {id}: {e}")))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| SttError::SidecarFailed(format!("failed to flush segment {id}: {e}")))?;

        loop {
            let line = tokio::time::timeout(SEGMENT_TIMEOUT, self.next_line())
                .await
                .map_err(|_| {
                    SttError::SidecarFailed(format!(
                        "no result for segment {id} within {SEGMENT_TIMEOUT:?}"
                    ))
                })??;
            match line {
                None => {
                    return Err(SttError::SidecarFailed(
                        "sidecar exited mid-session".to_string(),
                    ));
                }
                Some(SidecarLine::Result(result)) if result.id == id => {
                    return Ok(SegmentOutcome::Transcribed(result));
                }
                Some(SidecarLine::Result(result)) => {
                    log::warn!(
                        "{LOG} Ignoring stale result for segment {} while waiting for {id}",
                        result.id
                    );
                }
                Some(SidecarLine::Error {
                    id: error_id,
                    message,
                }) if error_id == id => {
                    return Ok(SegmentOutcome::Failed(message));
                }
                Some(SidecarLine::Error {
                    id: error_id,
                    message,
                }) => {
                    log::warn!(
                        "{LOG} Sidecar error for segment {error_id} while waiting for {id}: {message}"
                    );
                }
                Some(SidecarLine::Ready { .. }) => {
                    log::warn!("{LOG} Ignoring duplicate ready line");
                }
                Some(SidecarLine::Unknown(_)) => {}
            }
        }
    }

    /// Ask the sidecar to exit, wait [`SHUTDOWN_GRACE`], then kill it.
    async fn shutdown(self) {
        let Self {
            mut child,
            mut stdin,
            ..
        } = self;

        // A hung sidecar may have stopped draining stdin, so the shutdown
        // frame must not block forever.
        let _ = tokio::time::timeout(SHUTDOWN_GRACE, async {
            let _ = stdin.write_all(&encode_frame(0, &[])).await;
            let _ = stdin.flush().await;
        })
        .await;
        // Closing stdin is a second shutdown signal (EOF) for the sidecar.
        drop(stdin);

        match tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await {
            Ok(Ok(status)) => log::info!("{LOG} Sidecar exited: {status}"),
            Ok(Err(e)) => {
                log::warn!("{LOG} Waiting for sidecar failed ({e}); killing it");
                let _ = child.kill().await;
            }
            Err(_) => {
                log::warn!(
                    "{LOG} Sidecar did not exit within {SHUTDOWN_GRACE:?} of shutdown; killing it"
                );
                let _ = child.kill().await;
            }
        }
    }
}

/// Forward the sidecar's stderr to the app log, one line at a time.
async fn forward_stderr(stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log::info!("{LOG} {line}");
    }
}

/// Resolves [`STOP_GRACE`] after the cancel flag is set, and never before.
/// Raced against a segment's result so `stop()` is honored even while the
/// sidecar is hung mid-inference, instead of waiting out [`SEGMENT_TIMEOUT`].
async fn stop_deadline(cancelled: &AtomicBool) {
    while !cancelled.load(Ordering::SeqCst) {
        tokio::time::sleep(CANCEL_POLL).await;
    }
    tokio::time::sleep(STOP_GRACE).await;
}

/// Feed segments to the sidecar and emit transcript events until the
/// segment channel closes. `Err` means the sidecar died or hung; an error
/// event has already been sent.
#[expect(clippy::cast_precision_loss, reason = "audio sample count fits in f64")]
async fn run_inference(
    sidecar: &mut Sidecar,
    segment_rx: &mut mpsc::Receiver<Vec<i16>>,
    event_tx: &mpsc::Sender<TranscriptEvent>,
    cancelled: &AtomicBool,
) -> Result<(), SttError> {
    let mut next_id: u32 = 1;

    while let Some(segment) = segment_rx.recv().await {
        let id = next_id;
        next_id = next_id.wrapping_add(1);

        let samples = i16_to_f32(&segment);
        let audio_duration_s = segment.len() as f64 / SAMPLE_RATE_HZ;

        let started = Instant::now();
        let transcribed = tokio::select! {
            outcome = sidecar.transcribe(id, &samples) => outcome,
            () = stop_deadline(cancelled) => Err(SttError::SidecarFailed(format!(
                "no result for segment {id} within {STOP_GRACE:?} of stop"
            ))),
        };
        let outcome = match transcribed {
            Ok(outcome) => outcome,
            Err(e) => {
                log::error!("{LOG} Sidecar failed: {e}");
                let _ = event_tx
                    .send(TranscriptEvent::Error(format!("Bark sidecar failed: {e}")))
                    .await;
                return Err(e);
            }
        };
        let elapsed = started.elapsed();

        let result = match outcome {
            SegmentOutcome::Transcribed(result) => result,
            SegmentOutcome::Failed(message) => {
                log::error!("{LOG} Inference error on segment {id}: {message}");
                let _ = event_tx
                    .send(TranscriptEvent::Error(format!(
                        "Bark inference error: {message}"
                    )))
                    .await;
                continue;
            }
        };

        let text = result.text.trim().to_string();
        log::info!("{LOG} Transcribed {audio_duration_s:.1}s audio in {elapsed:?}: \"{text}\"");
        log::debug!(
            "{LOG} Segment {id}: sidecar inference {} ms, confidence {:.2}",
            result.elapsed_ms,
            result.confidence
        );

        if !text.is_empty() {
            let words = build_words(&result, audio_duration_s);
            let _ = event_tx
                .send(TranscriptEvent::Final {
                    transcript: text,
                    words,
                    confidence: result.confidence,
                    speech_final: true,
                })
                .await;
        }

        let _ = event_tx.send(TranscriptEvent::UtteranceEnd).await;
    }

    log::info!("{LOG} Inference loop exiting");
    Ok(())
}

// ── Provider ─────────────────────────────────────────────────────────────

/// Local Bark STT provider backed by the `bark-sidecar` process.
#[derive(Debug)]
pub struct BarkProvider {
    sidecar_path: PathBuf,
    model_dir: PathBuf,
    cancelled: Arc<AtomicBool>,
}

impl BarkProvider {
    /// Create a new Bark provider.
    ///
    /// - `sidecar_path`: path to the `bark-sidecar` executable
    /// - `model_dir`: directory holding the Core ML model (`Encoder.mlmodelc` etc.)
    pub fn new(sidecar_path: PathBuf, model_dir: PathBuf) -> Self {
        Self {
            sidecar_path,
            model_dir,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Tear down a sidecar that failed before `ready`, reporting the error
    /// to the event stream. Returns the error for the caller to propagate.
    async fn abort_start(
        sidecar: Sidecar,
        event_tx: &mpsc::Sender<TranscriptEvent>,
        error: SttError,
    ) -> SttError {
        log::error!("{LOG} Sidecar failed to start: {error}");
        let _ = event_tx
            .send(TranscriptEvent::Error(format!(
                "Bark sidecar failed to start: {error}"
            )))
            .await;
        sidecar.shutdown().await;
        let _ = event_tx.send(TranscriptEvent::Disconnected).await;
        error
    }
}

#[async_trait::async_trait]
impl SttProvider for BarkProvider {
    async fn start(
        &self,
        audio_rx: Receiver<Vec<i16>>,
        event_tx: mpsc::Sender<TranscriptEvent>,
    ) -> Result<(), SttError> {
        if !self.sidecar_path.exists() {
            return Err(SttError::ModelNotFound(format!(
                "Bark sidecar not found: {}. Run: bun run build:bark-sidecar",
                self.sidecar_path.display()
            )));
        }
        if !self.model_dir.exists() {
            return Err(SttError::ModelNotFound(format!(
                "Bark model not found: {}. Download it in Settings > Speech Recognition.",
                self.model_dir.display()
            )));
        }

        log::info!(
            "{LOG} Starting sidecar {} with model {}",
            self.sidecar_path.display(),
            self.model_dir.display()
        );
        let mut sidecar = match Sidecar::spawn(&self.sidecar_path, &self.model_dir) {
            Ok(sidecar) => sidecar,
            Err(e) => {
                log::error!("{LOG} {e}");
                let _ = event_tx.send(TranscriptEvent::Error(e.to_string())).await;
                let _ = event_tx.send(TranscriptEvent::Disconnected).await;
                return Err(e);
            }
        };

        let load_ms = match tokio::time::timeout(READY_TIMEOUT, sidecar.wait_ready()).await {
            Ok(Ok(load_ms)) => load_ms,
            Ok(Err(e)) => return Err(Self::abort_start(sidecar, &event_tx, e).await),
            Err(_) => {
                let e = SttError::SidecarFailed(format!(
                    "sidecar did not report ready within {READY_TIMEOUT:?}"
                ));
                return Err(Self::abort_start(sidecar, &event_tx, e).await);
            }
        };
        log::info!("{LOG} Sidecar ready (model loaded in {load_ms} ms)");
        let _ = event_tx.send(TranscriptEvent::Connected).await;

        let cancelled = self.cancelled.clone();
        let (segment_tx, mut segment_rx) = mpsc::channel::<Vec<i16>>(4);

        // ── Task 1: VAD + audio accumulation (blocking) ──────────────────
        let vad_cancelled = cancelled.clone();
        let vad_event_tx = event_tx.clone();
        let vad_handle = tokio::task::spawn_blocking(move || {
            segmenter::run_segmenter(
                module_path!(),
                LOG,
                &audio_rx,
                &vad_cancelled,
                &vad_event_tx,
                &segment_tx,
            );
        });

        // ── Task 2: sidecar inference (async, on this task) ──────────────
        let outcome = run_inference(&mut sidecar, &mut segment_rx, &event_tx, &cancelled).await;
        if outcome.is_err() {
            // The sidecar is gone; stop the VAD task so the provider ends
            // instead of buffering audio nobody will transcribe.
            cancelled.store(true, Ordering::SeqCst);
        }
        drop(segment_rx);
        let _ = vad_handle.await;

        sidecar.shutdown().await;
        let _ = event_tx.send(TranscriptEvent::Disconnected).await;

        outcome
    }

    fn stop(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn name(&self) -> &'static str {
        "bark"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(text: &str, start: f64, end: f64, confidence: f64) -> SidecarToken {
        SidecarToken {
            text: text.to_string(),
            start,
            end,
            confidence,
        }
    }

    // ── Frame encoding ───────────────────────────────────────────────────

    #[test]
    fn encode_frame_should_write_header_and_little_endian_samples() {
        let frame = encode_frame(0x0102_0304, &[1.0, -0.5]);
        let mut expected = vec![0x04, 0x03, 0x02, 0x01, 2, 0, 0, 0];
        expected.extend_from_slice(&1.0_f32.to_le_bytes());
        expected.extend_from_slice(&(-0.5_f32).to_le_bytes());
        assert_eq!(frame, expected);
    }

    #[test]
    fn encode_frame_should_produce_eight_byte_shutdown_frame_for_no_samples() {
        assert_eq!(encode_frame(7, &[]), vec![7, 0, 0, 0, 0, 0, 0, 0]);
    }

    // ── Line parsing ─────────────────────────────────────────────────────

    #[test]
    fn parse_line_should_parse_ready() {
        let line = parse_line(r#"{"type":"ready","load_ms":1234}"#).unwrap();
        assert_eq!(line, SidecarLine::Ready { load_ms: 1234 });
    }

    #[test]
    fn parse_line_should_parse_result_with_tokens() {
        let line = parse_line(
            r#"{"type":"result","id":7,"text":"John 3","confidence":0.96,"elapsed_ms":85,"tokens":[{"text":"John","start":0.31,"end":0.52,"confidence":0.97},{"text":"3","start":0.6,"end":0.8,"confidence":0.9}]}"#,
        )
        .unwrap();
        assert_eq!(
            line,
            SidecarLine::Result(SidecarResult {
                id: 7,
                text: "John 3".to_string(),
                confidence: 0.96,
                elapsed_ms: 85,
                tokens: Some(vec![
                    token("John", 0.31, 0.52, 0.97),
                    token("3", 0.6, 0.8, 0.9)
                ]),
            })
        );
    }

    #[test]
    fn parse_line_should_parse_result_without_tokens() {
        let line = parse_line(
            r#"{"type":"result","id":2,"text":"hello","confidence":0.5,"elapsed_ms":10}"#,
        )
        .unwrap();
        assert_eq!(
            line,
            SidecarLine::Result(SidecarResult {
                id: 2,
                text: "hello".to_string(),
                confidence: 0.5,
                elapsed_ms: 10,
                tokens: None,
            })
        );
    }

    #[test]
    fn parse_line_should_parse_error() {
        let line = parse_line(r#"{"type":"error","id":9,"message":"boom"}"#).unwrap();
        assert_eq!(
            line,
            SidecarLine::Error {
                id: 9,
                message: "boom".to_string()
            }
        );
    }

    #[test]
    fn parse_line_should_reject_malformed_json() {
        assert!(matches!(
            parse_line("{not json"),
            Err(SttError::ParseError(_))
        ));
    }

    #[test]
    fn parse_line_should_reject_line_without_type() {
        assert!(matches!(
            parse_line(r#"{"id":1}"#),
            Err(SttError::ParseError(_))
        ));
    }

    #[test]
    fn parse_line_should_reject_result_without_required_fields() {
        assert!(matches!(
            parse_line(r#"{"type":"result","confidence":0.9}"#),
            Err(SttError::ParseError(_))
        ));
    }

    #[test]
    fn parse_line_should_report_unknown_type_instead_of_failing() {
        let line = parse_line(r#"{"type":"progress","percent":50}"#).unwrap();
        assert_eq!(line, SidecarLine::Unknown("progress".to_string()));
    }

    // ── Word mapping ─────────────────────────────────────────────────────

    #[test]
    fn words_from_tokens_should_lowercase_text_and_keep_original_and_timings() {
        let words = words_from_tokens(&[token("John", 0.31, 0.52, 0.97)]);
        assert_eq!(
            words,
            vec![Word {
                text: "john".to_string(),
                start: 0.31,
                end: 0.52,
                confidence: 0.97,
                punctuated_word: Some("John".to_string()),
            }]
        );
    }

    #[test]
    fn build_words_should_use_tokens_when_present() {
        let result = SidecarResult {
            id: 1,
            text: "John three".to_string(),
            confidence: 0.9,
            elapsed_ms: 1,
            tokens: Some(vec![
                token("John", 0.1, 0.2, 0.8),
                token("three", 0.3, 0.4, 0.7),
            ]),
        };
        let words = build_words(&result, 10.0);
        assert_eq!(words.len(), 2);
        assert!((words[1].start - 0.3).abs() < f64::EPSILON);
    }

    #[test]
    fn build_words_should_space_words_evenly_without_tokens() {
        let result = SidecarResult {
            id: 1,
            text: "John three sixteen, amen.".to_string(),
            confidence: 0.9,
            elapsed_ms: 1,
            tokens: None,
        };
        let words = build_words(&result, 4.0);
        let expected = vec![
            Word {
                text: "john".into(),
                start: 0.0,
                end: 1.0,
                confidence: 0.9,
                punctuated_word: Some("John".into()),
            },
            Word {
                text: "three".into(),
                start: 1.0,
                end: 2.0,
                confidence: 0.9,
                punctuated_word: Some("three".into()),
            },
            Word {
                text: "sixteen,".into(),
                start: 2.0,
                end: 3.0,
                confidence: 0.9,
                punctuated_word: Some("sixteen,".into()),
            },
            Word {
                text: "amen.".into(),
                start: 3.0,
                end: 4.0,
                confidence: 0.9,
                punctuated_word: Some("amen.".into()),
            },
        ];
        assert_eq!(words, expected);
    }

    #[test]
    fn build_words_should_fall_back_when_tokens_are_empty() {
        let result = SidecarResult {
            id: 1,
            text: "amen".to_string(),
            confidence: 0.9,
            elapsed_ms: 1,
            tokens: Some(Vec::new()),
        };
        let words = build_words(&result, 2.0);
        assert_eq!(words.len(), 1);
    }

    #[test]
    fn evenly_spaced_words_should_return_nothing_for_blank_text() {
        assert!(evenly_spaced_words("   ", 2.0, 0.9).is_empty());
    }
}

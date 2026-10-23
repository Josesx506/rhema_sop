//! Local Whisper STT provider using whisper.cpp via whisper-rs.
//!
//! Processes audio through the app's VAD to detect speech boundaries,
//! then runs Whisper inference on each speech segment. Emits the same
//! [`TranscriptEvent`] types as the Deepgram provider.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crossbeam_channel::Receiver;
use tokio::sync::mpsc;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

use crate::error::SttError;
use crate::provider::SttProvider;
use crate::segmenter::{self, i16_to_f32};
use crate::types::{TranscriptEvent, Word};

/// Extract transcript text, words, and average confidence from Whisper state.
#[expect(clippy::cast_precision_loss, reason = "timestamps and word counts are small enough")]
fn extract_segments(state: &WhisperState) -> (String, Vec<Word>, f64) {
    let n_segments = state.full_n_segments();
    let mut full_text = String::new();
    let mut words = Vec::new();
    let mut total_confidence: f64 = 0.0;

    for i in 0..n_segments {
        let Some(segment) = state.get_segment(i) else { continue; };
        let text = segment.to_str_lossy().unwrap_or_default().to_string();
        let start_ts = segment.start_timestamp();
        let end_ts = segment.end_timestamp();

        let start_sec = start_ts as f64 / 100.0;
        let end_sec = end_ts as f64 / 100.0;
        let confidence = 0.9;

        let n_words = text.split_whitespace().count();
        if n_words > 0 {
            let duration_per_word = (end_sec - start_sec) / n_words as f64;
            for (j, word_text) in text.split_whitespace().enumerate() {
                let w_start = start_sec + (j as f64 * duration_per_word);
                let w_end = w_start + duration_per_word;
                words.push(Word {
                    text: word_text.to_lowercase(),
                    start: w_start,
                    end: w_end,
                    confidence,
                    punctuated_word: Some(word_text.to_string()),
                });
            }
        }

        full_text.push_str(&text);
        total_confidence += confidence;
    }

    let avg_confidence = if n_segments > 0 {
        total_confidence / f64::from(n_segments)
    } else {
        0.0
    };

    (full_text.trim().to_string(), words, avg_confidence)
}

/// Local Whisper STT provider.
pub struct WhisperProvider {
    model_path: PathBuf,
    language: Option<String>,
    n_threads: i32,
    cancelled: Arc<AtomicBool>,
}

impl WhisperProvider {
    /// Create a new Whisper provider.
    ///
    /// - `model_path`: path to a GGML model file
    /// - `language`: ISO language code (e.g. "en") or `None` for auto-detect
    /// - `n_threads`: number of CPU threads for inference
    pub fn new(model_path: PathBuf, language: Option<String>, n_threads: i32) -> Self {
        Self {
            model_path,
            language,
            n_threads: n_threads.max(1),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl std::fmt::Debug for WhisperProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WhisperProvider")
            .field("model_path", &self.model_path)
            .field("language", &self.language)
            .field("n_threads", &self.n_threads)
            .finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl SttProvider for WhisperProvider {
    async fn start(
        &self,
        audio_rx: Receiver<Vec<i16>>,
        event_tx: mpsc::Sender<TranscriptEvent>,
    ) -> Result<(), SttError> {
        if !self.model_path.exists() {
            return Err(SttError::ModelNotFound(format!(
                "Whisper model not found: {}",
                self.model_path.display()
            )));
        }

        let _ = event_tx.send(TranscriptEvent::Connected).await;

        let model_path = self.model_path.clone();
        let language = self.language.clone();
        let n_threads = self.n_threads;
        let cancelled = self.cancelled.clone();

        let (inference_tx, mut inference_rx) = mpsc::channel::<Vec<i16>>(4);

        // ── Task 1: VAD + audio accumulation ─────────────────────────────
        // The buffering and flush loop is shared with the Bark provider; the
        // log target and prefix keep Whisper's log output unchanged.
        let vad_cancelled = cancelled.clone();
        let vad_event_tx = event_tx.clone();
        let vad_handle = tokio::task::spawn_blocking(move || {
            segmenter::run_segmenter(
                module_path!(),
                "[WHISPER]",
                &audio_rx,
                &vad_cancelled,
                &vad_event_tx,
                &inference_tx,
            );
        });

        // ── Task 2: Whisper inference ────────────────────────────────────
        let inf_cancelled = cancelled.clone();
        let inf_event_tx = event_tx.clone();
        let inf_handle = tokio::task::spawn_blocking(move || {
            let ctx = match WhisperContext::new_with_params(
                &model_path,
                WhisperContextParameters::default(),
            ) {
                Ok(ctx) => ctx,
                Err(e) => {
                    log::error!("[Whisper] Failed to load model: {e}");
                    let _ = inf_event_tx.blocking_send(TranscriptEvent::Error(
                        format!("Failed to load Whisper model: {e}"),
                    ));
                    return;
                }
            };

            let mut state = match ctx.create_state() {
                Ok(s) => s,
                Err(e) => {
                    log::error!("[Whisper] Failed to create state: {e}");
                    let _ = inf_event_tx.blocking_send(TranscriptEvent::Error(
                        format!("Failed to create Whisper state: {e}"),
                    ));
                    return;
                }
            };

            log::info!("[Whisper] Model loaded, ready for inference");

            while let Some(audio_i16) = inference_rx.blocking_recv() {
                if inf_cancelled.load(Ordering::SeqCst) {
                    break;
                }

                let audio_f32 = i16_to_f32(&audio_i16);

                let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
                params.set_language(Some(
                    language.as_deref().unwrap_or("en"),
                ));
                params.set_n_threads(n_threads);
                params.set_print_progress(false);
                params.set_print_special(false);
                params.set_print_realtime(false);
                params.set_single_segment(false);
                params.set_token_timestamps(true);
                params.set_no_speech_thold(0.6);
                params.set_suppress_blank(true);
                params.set_suppress_nst(true);

                let start = std::time::Instant::now();
                if let Err(e) = state.full(params, &audio_f32) {
                    log::error!("[Whisper] Inference error: {e}");
                    let _ = inf_event_tx.blocking_send(TranscriptEvent::Error(
                        format!("Whisper inference error: {e}"),
                    ));
                    continue;
                }
                let elapsed = start.elapsed();

                let (text, words, confidence) = extract_segments(&state);

                #[expect(clippy::cast_precision_loss, reason = "audio sample count fits in f64")]
                let audio_duration_s = audio_i16.len() as f64 / 16_000.0;
                log::info!(
                    "[Whisper] Transcribed {audio_duration_s:.1}s audio in {elapsed:.1?}: \"{text}\""
                );

                if !text.is_empty() {
                    let _ = inf_event_tx.blocking_send(TranscriptEvent::Final {
                        transcript: text,
                        words,
                        confidence,
                        speech_final: true,
                    });
                }

                let _ = inf_event_tx.blocking_send(TranscriptEvent::UtteranceEnd);
            }

            log::info!("[Whisper] Inference task exiting");
        });

        let _ = tokio::join!(vad_handle, inf_handle);
        let _ = event_tx.send(TranscriptEvent::Disconnected).await;

        Ok(())
    }

    fn stop(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn name(&self) -> &'static str {
        "whisper"
    }
}

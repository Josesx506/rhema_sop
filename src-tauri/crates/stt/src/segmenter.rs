//! Shared VAD segmentation loop for the local STT providers.
//!
//! Both the Whisper and Bark providers consume raw 16 kHz mono i16 audio,
//! gate it through the app's energy VAD, accumulate the voiced frames into a
//! buffer and hand complete speech segments to an inference loop. This module
//! holds that buffering and flush logic so the two providers behave
//! identically; only the inference side differs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crossbeam_channel::Receiver;
use rhema_audio::{AudioFrame, Vad, VadConfig, VadTransition};
use tokio::sync::mpsc;

use crate::types::TranscriptEvent;

/// Maximum audio buffer before force-flushing to inference (10 seconds at 16 kHz).
pub(crate) const MAX_BUFFER_SAMPLES: usize = 16_000 * 10;

/// Minimum audio buffer for inference (1.0 seconds).
/// Whisper warns "input is too short" below 1s.
pub(crate) const MIN_BUFFER_SAMPLES: usize = 16_000;

/// Convert i16 PCM samples to f32 in [-1.0, 1.0] range.
pub(crate) fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|&s| f32::from(s) / 32768.0).collect()
}

/// Run the VAD buffering loop on the current thread until cancelled or the
/// audio source disconnects.
///
/// Voiced audio accumulates in a buffer that is flushed to `segment_tx` when
/// the VAD reports `SpeechEnded`, when the buffer reaches
/// [`MAX_BUFFER_SAMPLES`], on cancel, and when `audio_rx` disconnects.
/// Buffers shorter than [`MIN_BUFFER_SAMPLES`] are dropped. `SpeechStarted`
/// transitions are forwarded to `event_tx`.
///
/// `log_target` and `log_prefix` are stamped on every log record so each
/// provider's log output is indistinguishable from an inline loop.
///
/// This function blocks; call it from `tokio::task::spawn_blocking`.
#[expect(
    clippy::cast_precision_loss,
    reason = "audio sample counts fit comfortably in f64"
)]
pub(crate) fn run_segmenter(
    log_target: &str,
    log_prefix: &str,
    audio_rx: &Receiver<Vec<i16>>,
    cancelled: &AtomicBool,
    event_tx: &mpsc::Sender<TranscriptEvent>,
    segment_tx: &mpsc::Sender<Vec<i16>>,
) {
    // Higher thresholds than default to avoid sending near-silence
    // to the model (which causes hallucinations).
    let vad_config = VadConfig {
        silence_threshold: 0.01,
        frame_threshold: 0.005,
        min_voice_frames: 6,
        ..VadConfig::default()
    };
    let mut vad = Vad::new(vad_config);
    let mut audio_buffer: Vec<i16> = Vec::new();
    let mut frames_seen: u64 = 0;

    loop {
        if cancelled.load(Ordering::SeqCst) {
            if audio_buffer.len() >= MIN_BUFFER_SAMPLES {
                let _ = segment_tx.blocking_send(std::mem::take(&mut audio_buffer));
            }
            break;
        }

        match audio_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(samples) => {
                let frame = AudioFrame {
                    samples,
                    timestamp_ms: 0,
                };
                let result = vad.process(&frame);

                if let Some(transition) = result.transition {
                    match transition {
                        VadTransition::SpeechStarted => {
                            let _ = event_tx.blocking_send(TranscriptEvent::SpeechStarted);
                        }
                        VadTransition::SpeechEnded => {
                            log::info!(
                                target: log_target,
                                "{log_prefix} flush on SpeechEnded: audio_buffer={} samples ({:.1}s)",
                                audio_buffer.len(),
                                audio_buffer.len() as f64 / 16_000.0,
                            );
                            if audio_buffer.len() >= MIN_BUFFER_SAMPLES {
                                let _ = segment_tx.blocking_send(std::mem::take(&mut audio_buffer));
                            } else {
                                audio_buffer.clear();
                            }
                        }
                    }
                }

                for frame in result.frames {
                    audio_buffer.extend_from_slice(&frame.samples);
                    frames_seen += 1;
                }

                if frames_seen.is_multiple_of(50) && !audio_buffer.is_empty() {
                    log::debug!(
                        target: log_target,
                        "{log_prefix} audio_buffer={} samples ({:.1}s) frames_seen={frames_seen}",
                        audio_buffer.len(),
                        audio_buffer.len() as f64 / 16_000.0,
                    );
                }

                if audio_buffer.len() >= MAX_BUFFER_SAMPLES {
                    log::warn!(
                        target: log_target,
                        "{log_prefix} flush on MAX_BUFFER ({} samples / {:.1}s) — VAD never closed",
                        audio_buffer.len(),
                        audio_buffer.len() as f64 / 16_000.0,
                    );
                    let _ = segment_tx.blocking_send(std::mem::take(&mut audio_buffer));
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                if audio_buffer.len() >= MIN_BUFFER_SAMPLES {
                    let _ = segment_tx.blocking_send(std::mem::take(&mut audio_buffer));
                }
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i16_to_f32_should_scale_full_scale_samples_into_unit_range() {
        let out = i16_to_f32(&[0, i16::MAX, i16::MIN, 16_384]);
        assert_eq!(out, vec![0.0, 32_767.0 / 32_768.0, -1.0, 0.5]);
    }
}

//! Speech-to-text integration for the Rhema application.
//!
//! Provides real-time transcription via multiple providers:
//! - **Deepgram** (cloud) — WebSocket streaming with keyword boosting
//! - **Whisper** (local) — offline inference via whisper.cpp
//! - **Bark** (local, macOS only): Underdog Bark 3.0 through a `FluidAudio`
//!   Core ML sidecar process
//!
//! # Key types
//!
//! - [`SttProvider`] — trait for swappable STT backends
//! - [`DeepgramClient`] — Deepgram WebSocket/REST provider
//! - [`TranscriptEvent`] — streaming transcript events (partial, final, etc.)
//! - [`SttConfig`] — API configuration
//! - [`SttError`] — error type for STT operations
//!
//! # Feature flags
//!
//! - `rest-fallback` — enables REST API fallback client
//! - `whisper` — enables local Whisper STT provider
//! - `bark`: enables the local Bark STT provider (compiles to nothing off macOS)

pub mod deepgram;
pub mod error;
pub mod keyterms;
pub mod provider;
pub mod rest;
pub mod types;

#[cfg(any(feature = "whisper", all(feature = "bark", target_os = "macos")))]
pub(crate) mod segmenter;

#[cfg(feature = "whisper")]
pub mod whisper;

#[cfg(all(feature = "bark", target_os = "macos"))]
pub mod bark;

pub use deepgram::DeepgramClient;
pub use error::SttError;
pub use keyterms::bible_keyterms;
pub use provider::SttProvider;
pub use types::{SttConfig, TranscriptEvent, Word};

#[cfg(feature = "whisper")]
pub use whisper::WhisperProvider;

#[cfg(all(feature = "bark", target_os = "macos"))]
pub use bark::BarkProvider;

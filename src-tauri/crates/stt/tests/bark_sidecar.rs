//! Integration test: drive `BarkProvider` end to end against a fake sidecar
//! script that speaks the protocol without loading a model.

#![cfg(all(feature = "bark", target_os = "macos"))]

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use rhema_stt::{BarkProvider, SttProvider, TranscriptEvent};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn python3_available() -> bool {
    Command::new("python3")
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success())
}

/// 1024 samples (64 ms) of a 440 Hz tone, loud enough for the VAD to count
/// as speech.
#[expect(
    clippy::cast_possible_truncation,
    reason = "amplitude is well inside i16 range"
)]
fn tone_chunk(phase: &mut f32) -> Vec<i16> {
    let step = 440.0 * std::f32::consts::TAU / 16_000.0;
    (0..1024)
        .map(|_| {
            *phase += step;
            (phase.sin() * 8_000.0) as i16
        })
        .collect()
}

fn kind(event: &TranscriptEvent) -> &'static str {
    match event {
        TranscriptEvent::Partial { .. } => "Partial",
        TranscriptEvent::Final { .. } => "Final",
        TranscriptEvent::UtteranceEnd => "UtteranceEnd",
        TranscriptEvent::SpeechStarted => "SpeechStarted",
        TranscriptEvent::Error(_) => "Error",
        TranscriptEvent::Connected => "Connected",
        TranscriptEvent::Disconnected => "Disconnected",
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn provider_should_emit_full_event_sequence_against_fake_sidecar() {
    if !python3_available() {
        eprintln!("skipping bark sidecar integration test: python3 is not available");
        return;
    }

    let provider = Arc::new(BarkProvider::new(
        fixtures_dir().join("fake-bark-sidecar.sh"),
        fixtures_dir(),
    ));
    assert_eq!(provider.name(), "bark");

    let (audio_tx, audio_rx) = crossbeam_channel::unbounded::<Vec<i16>>();
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<TranscriptEvent>(64);

    let runner = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.start(audio_rx, event_tx).await })
    };

    // Three seconds of tone so the VAD opens and buffers well over the
    // one-second minimum, then two seconds of silence so it closes the
    // segment and flushes it to the sidecar.
    let mut phase = 0.0_f32;
    for _ in 0..47 {
        audio_tx
            .send(tone_chunk(&mut phase))
            .expect("audio channel open");
    }
    for _ in 0..32 {
        audio_tx.send(vec![0; 1024]).expect("audio channel open");
    }

    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(30), event_rx.recv())
            .await
            .expect("timed out waiting for UtteranceEnd")
            .expect("event channel closed before UtteranceEnd");
        let done = matches!(event, TranscriptEvent::UtteranceEnd);
        events.push(event);
        if done {
            break;
        }
    }

    provider.stop();
    drop(audio_tx);
    let result = tokio::time::timeout(Duration::from_secs(10), runner)
        .await
        .expect("provider did not exit after stop()")
        .expect("provider task panicked");
    assert!(result.is_ok(), "provider returned {result:?}");

    while let Some(event) = event_rx.recv().await {
        events.push(event);
    }

    let kinds: Vec<&str> = events.iter().map(kind).collect();
    assert_eq!(
        kinds,
        [
            "Connected",
            "SpeechStarted",
            "Final",
            "UtteranceEnd",
            "Disconnected"
        ]
    );

    let TranscriptEvent::Final {
        transcript,
        words,
        confidence,
        speech_final,
    } = &events[2]
    else {
        unreachable!("third event is Final per the assertion above");
    };
    assert_eq!(transcript, "John three sixteen");
    assert!(*speech_final);
    assert!((confidence - 0.95).abs() < f64::EPSILON);
    assert_eq!(words.len(), 3);
    assert_eq!(words[0].text, "john");
    assert_eq!(words[0].punctuated_word.as_deref(), Some("John"));
    assert!((words[2].end - 0.9).abs() < f64::EPSILON);
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_should_end_provider_while_sidecar_is_hung() {
    let provider = Arc::new(BarkProvider::new(
        fixtures_dir().join("hung-bark-sidecar.sh"),
        fixtures_dir(),
    ));

    let (audio_tx, audio_rx) = crossbeam_channel::unbounded::<Vec<i16>>();
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<TranscriptEvent>(64);

    let runner = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.start(audio_rx, event_tx).await })
    };

    // One speech segment, which the sidecar accepts but never answers.
    let mut phase = 0.0_f32;
    for _ in 0..47 {
        audio_tx
            .send(tone_chunk(&mut phase))
            .expect("audio channel open");
    }
    for _ in 0..32 {
        audio_tx.send(vec![0; 1024]).expect("audio channel open");
    }

    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(30), event_rx.recv())
            .await
            .expect("timed out waiting for SpeechStarted")
            .expect("event channel closed before SpeechStarted");
        let started = matches!(event, TranscriptEvent::SpeechStarted);
        events.push(event);
        if started {
            break;
        }
    }
    // Let the segmenter flush the segment so the provider is parked waiting
    // for a result that never comes.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let stopped_at = std::time::Instant::now();
    provider.stop();
    drop(audio_tx);
    let result = tokio::time::timeout(Duration::from_secs(20), runner)
        .await
        .expect("provider did not exit after stop() while the sidecar was hung")
        .expect("provider task panicked");
    // Well under the 30 s segment timeout: stop grace plus shutdown grace.
    assert!(
        stopped_at.elapsed() < Duration::from_secs(12),
        "stop took {:?}",
        stopped_at.elapsed()
    );
    assert!(
        result.is_err(),
        "a hung sidecar must be reported, got {result:?}"
    );

    while let Some(event) = event_rx.recv().await {
        events.push(event);
    }
    let kinds: Vec<&str> = events.iter().map(kind).collect();
    assert_eq!(
        kinds,
        ["Connected", "SpeechStarted", "Error", "Disconnected"]
    );
}

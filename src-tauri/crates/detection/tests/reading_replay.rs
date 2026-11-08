//! Replays real service transcripts through direct detection + reading mode
//! and scores the verse that would be on screen after each utterance against
//! hand labels.
//!
//! Fixtures (`tests/fixtures/reading/*.json`) are final transcripts taken
//! from `Rhema.log`. They are real services, so they stay local (the folder
//! is gitignored) and the test skips without them; `make_fixtures.py` in
//! that folder rebuilds them from a log. Each scored utterance lists the verses acceptable on
//! screen after it; the first fragment of a newly started verse accepts the
//! previous verse too, since nothing can switch before hearing the new one.
//!
//! Verse texts come from the local `data/rhema.db` (most translations are
//! copyrighted, so they aren't committed); without it the test skips. Point
//! `RHEMA_BIBLE_DB` at another copy to override. Run with `--nocapture` to
//! see every miss:
//!
//! ```sh
//! cargo test -p rhema-detection --test reading_replay -- --nocapture
//! ```
//!
//! Every fixture is replayed twice: finals only (Whisper, Bark), and with
//! simulated partials — each final's word prefixes, every few words, fed
//! through direct detection and `process_partial` first, as Deepgram's
//! interim results are.
//!
//! `READING_TRACE=1` also prints every utterance with the verse on screen
//! after it, and `READING_FIXTURES=<dir>` replays another directory —
//! useful for eyeballing unlabelled sessions for wrong moves.

use std::path::{Path, PathBuf};

use rhema_bible::BibleDb;
use rhema_detection::{ChapterVerse, DetectionMerger, DirectDetector, ReadingMode};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    name: String,
    book_number: i32,
    chapter: i32,
    display_translation: i64,
    utterances: Vec<Utterance>,
}

#[derive(Deserialize)]
struct Utterance {
    t: f64,
    text: String,
    #[serde(default)]
    expect: Option<Vec<i32>>,
}

/// Minimum share of scored utterances showing an acceptable verse, per
/// fixture and over all of them. Before the in-order tracker, the same
/// fixtures (less revelation-7-9) scored 104/136 = 76.5%.
const MIN_ACCURACY: &[(&str, f64)] = &[
    ("1-john-2-12", 0.95),
    ("genesis-1-3", 0.95),
    ("malachi-3-4", 0.95),
    ("proverbs-31-1", 0.95),
    ("revelation-4-1", 0.90),
    ("revelation-7-9", 0.95),
    ("romans-12-1", 0.95),
];
const MIN_OVERALL_ACCURACY: f64 = 0.95;

/// Words between simulated partial transcripts.
const PARTIAL_STEP_WORDS: usize = 3;

struct Score {
    name: String,
    scored: usize,
    correct: usize,
    misses: Vec<String>,
    /// Reading-mode moves, and how many of them a partial made.
    moves: usize,
    early_moves: usize,
}

fn replay(db: &BibleDb, fixture: &Fixture, with_partials: bool) -> Score {
    let mut detector = DirectDetector::new();
    let mut merger = DetectionMerger::new();
    // Utterances are replayed back to back; the 2.5s auto-display cooldown
    // would drop references that were seconds apart live.
    merger.set_cooldown_ms(0);
    let mut reading = ReadingMode::new();
    let translation = fixture.display_translation;
    let mut load_chapter = |book: i32, chapter: i32| {
        let rows = db.get_chapter_parallel(translation, book, chapter).ok()?;
        Some(ChapterVerse::from_parallel(rows, translation))
    };

    // (book, chapter, verse) on screen, as the app's auto-present would set it.
    let mut shown: Option<(i32, i32, i32)> = None;
    let mut score = Score { name: fixture.name.clone(), scored: 0, correct: 0, misses: Vec::new(), moves: 0, early_moves: 0 };
    let trace = std::env::var_os("READING_TRACE").is_some();

    for utterance in &fixture.utterances {
        if with_partials {
            let words: Vec<&str> = utterance.text.split_whitespace().collect();
            for end in (PARTIAL_STEP_WORDS..words.len()).step_by(PARTIAL_STEP_WORDS) {
                let partial = words[..end].join(" ");
                // The app runs direct detection on partials too.
                let results = merger.merge(detector.detect(&partial), vec![]);
                if let Some(m) = results.iter().find(|m| m.auto_queued) {
                    let r = &m.detection.verse_ref;
                    shown = Some((r.book_number, r.chapter, r.verse_start));
                }
                if let Some(advance) = reading.process_partial(&partial, &detector.mentioned_books(&partial)) {
                    shown = Some((advance.book_number, advance.chapter, advance.verse));
                    score.moves += 1;
                    score.early_moves += 1;
                }
            }
        }
        let results = merger.merge(detector.detect(&utterance.text), vec![]);
        let direct_hit = if results.is_empty() { None } else { detector.recent_detections().front().cloned() };
        if let Some(m) = results.iter().find(|m| m.auto_queued) {
            let r = &m.detection.verse_ref;
            shown = Some((r.book_number, r.chapter, r.verse_start));
        }
        let mentioned = detector.mentioned_books(&utterance.text);
        if let Some(advance) = reading.process(&utterance.text, direct_hit.as_ref(), &mentioned, &mut load_chapter) {
            shown = Some((advance.book_number, advance.chapter, advance.verse));
            score.moves += 1;
        }

        if trace {
            let on_screen = shown.map_or_else(|| "-".to_string(), |(b, c, v)| format!("{b} {c}:{v}"));
            println!("    {:>6.1}s  {on_screen:<10} {:?}", utterance.t, utterance.text);
        }
        let Some(expect) = &utterance.expect else { continue };
        score.scored += 1;
        let ok = shown.is_some_and(|(b, c, v)| b == fixture.book_number && c == fixture.chapter && expect.contains(&v));
        if ok {
            score.correct += 1;
        } else {
            let on_screen = match shown {
                Some((b, c, v)) if b == fixture.book_number && c == fixture.chapter => format!("v{v}"),
                Some((b, c, v)) => format!("book {b} {c}:{v}"),
                None => "nothing".to_string(),
            };
            score.misses.push(format!(
                "{:>6.1}s  showing {on_screen:<14} want {expect:?}  {:?}",
                utterance.t, utterance.text
            ));
        }
    }
    score
}

fn db_path() -> PathBuf {
    std::env::var_os("RHEMA_BIBLE_DB").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../data/rhema.db"),
        PathBuf::from,
    )
}

#[test]
fn replay_reading_fixtures() {
    let path = db_path();
    if !path.exists() {
        eprintln!("skipping reading replay: no Bible database at {}", path.display());
        return;
    }
    let db = BibleDb::open(&path).expect("open Bible database");

    let dir = std::env::var_os("READING_FIXTURES").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/reading"),
        PathBuf::from,
    );
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("skipping reading replay: no fixtures at {}", dir.display());
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .map(|e| e.expect("fixture entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();

    let mut failures = Vec::new();
    // (scored, correct) for finals only, then with partials.
    let mut totals = [(0_usize, 0_usize); 2];
    println!();
    for file in &files {
        let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(file).expect("read fixture"))
            .unwrap_or_else(|e| panic!("parse {}: {e}", file.display()));
        for with_partials in [false, true] {
            let score = replay(&db, &fixture, with_partials);
            let mode = if with_partials { "+partials" } else { "finals" };
            #[expect(clippy::cast_precision_loss, reason = "utterance counts are small")]
            let accuracy = score.correct as f64 / score.scored.max(1) as f64;
            let early = if with_partials { format!("  ({}/{} moves on a partial)", score.early_moves, score.moves) } else { String::new() };
            println!("{:<16} {mode:<9} {:>3}/{:<3} {:>5.1}%{early}", score.name, score.correct, score.scored, accuracy * 100.0);
            for miss in &score.misses {
                println!("    {miss}");
            }
            let totals = &mut totals[usize::from(with_partials)];
            totals.0 += score.scored;
            totals.1 += score.correct;
            if let Some((_, min)) = MIN_ACCURACY.iter().find(|(n, _)| *n == score.name) {
                if accuracy < *min {
                    failures.push(format!("{} ({mode}): {:.1}% < {:.1}%", score.name, accuracy * 100.0, min * 100.0));
                }
            }
        }
    }
    for (with_partials, (scored, correct)) in [false, true].into_iter().zip(totals) {
        let mode = if with_partials { "+partials" } else { "finals" };
        #[expect(clippy::cast_precision_loss, reason = "utterance counts are small")]
        let overall = correct as f64 / scored.max(1) as f64;
        println!("{:<16} {mode:<9} {correct:>3}/{scored:<3} {:>5.1}%", "overall", overall * 100.0);
        if scored > 0 && overall < MIN_OVERALL_ACCURACY {
            failures.push(format!("overall ({mode}): {:.1}% < {:.1}%", overall * 100.0, MIN_OVERALL_ACCURACY * 100.0));
        }
    }
    assert!(failures.is_empty(), "reading replay below threshold:\n{}", failures.join("\n"));
}

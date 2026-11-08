use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde::Serialize;

use crate::direct::parser::parse_spoken_number;

/// Timeout: pause reading mode after 3 minutes of no verse matches.
/// Context is maintained for ~3 minutes. Verses stay loaded for re-activation.
const READING_MODE_TIMEOUT_MS: u128 = 180_000;

/// Minimum in-order score for an utterance to count as reading a verse —
/// about two words that identify it (see `word_weights`).
const MIN_MATCH_SCORE: f64 = 1.6;

/// How far a later verse must outscore the current one to move to it.
const ADVANCE_MARGIN: f64 = 0.3;

/// Verses ahead of the current one considered for a move (1 = next only).
const LOOKAHEAD_VERSES: usize = 3;

/// Score discount per verse skipped, so the next verse wins ties.
const SKIP_PENALTY: f64 = 0.25;

/// Past the end of a spoken range ("verses 3 to 5") the reader has to be
/// clearly reading on, not commenting, before the screen follows.
const PAST_RANGE_FACTOR: f64 = 2.0;

/// Extra evidence a partial transcript needs before the screen follows it,
/// since its words can still change before the final.
const INTERIM_FACTOR: f64 = 1.5;

/// In-order score needed to jump to a verse outside the lookahead when the
/// current verse doesn't match at all — several identifying words in a row.
const RELOCATE_SCORE: f64 = 3.0;

/// A verse loaded for reading mode tracking.
#[derive(Debug, Clone)]
struct LoadedVerse {
    verse_number: i32,
    text: String,
    /// Content-word sequence of each loaded translation (display first),
    /// in reading order, for in-order matching against the transcript.
    texts: Vec<Vec<String>>,
}

/// Result when reading mode advances to a new verse.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReadingAdvance {
    pub book_number: i32,
    pub book_name: String,
    pub chapter: i32,
    pub verse: i32,
    pub verse_text: String,
    pub reference: String,
    pub confidence: f64,
}

/// Signal that reading mode wants to change to a different chapter.
/// The caller must load the new chapter from the database and call `start()`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChapterChange {
    pub book_number: i32,
    pub book_name: String,
    pub new_chapter: i32,
    /// Optional verse number to start at (e.g., "chapter 3 verse 5" → verse 5)
    /// If None, starts at verse 1
    pub start_verse: Option<i32>,
}

/// One verse of a chapter as reading mode loads it: the text to display
/// (active translation) plus the same verse in the other translations of
/// that language, which the matcher also compares the transcript against.
#[derive(Debug, Clone, PartialEq)]
pub struct ChapterVerse {
    pub verse: i32,
    pub text: String,
    pub alternates: Vec<String>,
}

impl ChapterVerse {
    /// Group `BibleDb::get_chapter_parallel` rows into one entry per verse.
    /// Verses missing from the display translation are dropped — presenting
    /// another translation's text under the active one is worse than a gap.
    pub fn from_parallel(rows: Vec<rhema_bible::Verse>, display_translation: i64) -> Vec<Self> {
        let mut out: Vec<Self> = Vec::new();
        let mut current: Option<i32> = None;
        let mut display: Option<String> = None;
        let mut alternates: Vec<String> = Vec::new();
        // A trailing `None` flushes the last verse.
        for row in rows.into_iter().map(Some).chain(std::iter::once(None)) {
            let verse = row.as_ref().map(|r| r.verse);
            if verse != current {
                if let (Some(v), Some(text)) = (current, display.take()) {
                    out.push(Self { verse: v, text, alternates: std::mem::take(&mut alternates) });
                }
                alternates.clear();
                current = verse;
            }
            let Some(row) = row else { break };
            if row.translation_id == display_translation {
                display = Some(row.text);
            } else {
                alternates.push(row.text);
            }
        }
        out
    }
}

/// Context for interpreting bare numbers after "chapter" commands.
#[derive(Debug, Clone, Copy, PartialEq)]
enum BareNumberContext {
    /// No special context - bare numbers are verses in current chapter
    None,
    /// After "Genesis chapter" - next bare number is a chapter number
    ExpectingChapter,
    /// After navigating to a chapter - next bare number is a verse in that chapter
    ExpectingVerse,
}

/// Tracks the current reading position and matches transcripts against
/// expected verse text to auto-advance through a passage.
///
/// Activated when direct detection catches a verse reference. Pre-loads
/// the remaining verses in the chapter. On each transcript, compares
/// word overlap against the current and next verse to detect advancement.
pub struct ReadingMode {
    active: bool,
    book_number: i32,
    book_name: String,
    chapter: i32,
    /// Index into `verses` for the current verse being read.
    current_index: usize,
    /// All verses from the starting verse to end of chapter.
    verses: Vec<LoadedVerse>,
    /// Last verse of the spoken range ("verses 3 to 5"), if one was given.
    /// Following past it takes much stronger evidence.
    range_end: Option<i32>,
    /// Per-word weight: words found in few verses of the chapter identify
    /// a verse; words in most of them ("God" in Genesis 1) barely count.
    weights: HashMap<String, f64>,
    /// Content words of the previous utterance while it is unresolved — it
    /// moved the screen or fit no verse clearly. Fragments are short, and
    /// the one before often decides an ambiguous one ("I have written to
    /// you fathers" + "because you have known Him…" is verse 14, not 13).
    /// Cleared once an utterance plainly continues the current verse, so a
    /// long stretch of it can't hold the screen through the next opening.
    previous_words: Vec<String>,
    /// Last time a verse match was found.
    last_match_time: Instant,
    /// Context for interpreting the next bare number
    bare_number_context: BareNumberContext,
}

impl ReadingMode {
    /// Create an inactive reading mode instance.
    pub fn new() -> Self {
        Self {
            active: false,
            book_number: 0,
            book_name: String::new(),
            chapter: 0,
            current_index: 0,
            verses: Vec::new(),
            range_end: None,
            weights: HashMap::new(),
            previous_words: Vec::new(),
            last_match_time: Instant::now(),
            bare_number_context: BareNumberContext::None,
        }
    }

    /// Activate reading mode starting from the given verse.
    ///
    /// `verses` should be `(verse_number, verse_text)` pairs for all verses
    /// from the starting verse to the end of the chapter.
    pub fn start(
        &mut self,
        book_number: i32,
        book_name: &str,
        chapter: i32,
        start_verse: i32,
        verses: Vec<(i32, String)>,
    ) {
        let verses = verses
            .into_iter()
            .map(|(verse, text)| ChapterVerse { verse, text, alternates: Vec::new() })
            .collect();
        self.start_passage(book_number, book_name, chapter, start_verse, None, verses);
    }

    /// Activate reading mode on a whole chapter, positioned at `start_verse`.
    ///
    /// `range_end` is the last verse of a spoken range ("verses 3 to 5");
    /// following continues past it only when the reader clearly carries on.
    pub fn start_passage(
        &mut self,
        book_number: i32,
        book_name: &str,
        chapter: i32,
        start_verse: i32,
        range_end: Option<i32>,
        verses: Vec<ChapterVerse>,
    ) {
        // Load ALL chapter verses so "verse N" can navigate backward too.
        let loaded: Vec<LoadedVerse> = verses
            .into_iter()
            .map(|v| LoadedVerse {
                verse_number: v.verse,
                texts: std::iter::once(&v.text).chain(&v.alternates).map(|t| content_words(t)).collect(),
                text: v.text,
            })
            .collect();

        if loaded.is_empty() {
            log::warn!("[READING] No verses loaded for {book_name} {chapter}:{start_verse}");
            return;
        }

        // Position cursor at start_verse; fall back to first verse.
        let start_index = loaded
            .iter()
            .position(|v| v.verse_number == start_verse)
            .unwrap_or(0);

        let range_end = range_end.filter(|&end| end > start_verse);
        log::info!(
            "[READING] Started: {book_name} {chapter}:{start_verse}{} ({} verses loaded)",
            range_end.map(|end| format!("-{end}")).unwrap_or_default(),
            loaded.len()
        );

        self.weights = word_weights(&loaded);
        self.active = true;
        self.book_number = book_number;
        self.book_name = book_name.to_string();
        self.chapter = chapter;
        self.current_index = start_index;
        self.verses = loaded;
        self.range_end = range_end;
        self.previous_words.clear();
        self.last_match_time = Instant::now();
    }

    /// Check if reading mode is currently active.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Check if verses are still loaded (paused but resumable).
    pub fn has_verses(&self) -> bool {
        !self.verses.is_empty()
    }

    /// Resume from the current position (re-activate after pause/toggle).
    pub fn resume(&mut self) {
        if !self.verses.is_empty() {
            self.active = true;
            self.last_match_time = Instant::now();
            let verse = self.verses.get(self.current_index).map_or(0, |v| v.verse_number);
            log::info!("[READING] Resumed at: {} {}:{verse}", self.book_name, self.chapter);
        }
    }

    /// Get the book number being tracked.
    pub fn current_book(&self) -> i32 {
        self.book_number
    }

    /// Get the chapter being tracked.
    pub fn current_chapter(&self) -> i32 {
        self.chapter
    }

    /// Get the book name being tracked.
    pub fn current_book_name(&self) -> &str {
        &self.book_name
    }

    /// Get the current verse number being tracked.
    pub fn current_verse(&self) -> Option<i32> {
        if self.active {
            self.verses.get(self.current_index).map(|v| v.verse_number)
        } else {
            None
        }
    }

    /// Set the bare number context (for chapter-only detections).
    /// Call this when a "book chapter" pattern is detected without a verse number.
    pub fn set_expecting_chapter(&mut self) {
        self.bare_number_context = BareNumberContext::ExpectingChapter;
        log::info!("[READING] Context set to ExpectingChapter");
    }

    /// Fully deactivate reading mode and clear all loaded verses.
    /// Called when the user turns the toggle OFF.
    pub fn deactivate(&mut self) {
        if self.active || !self.verses.is_empty() {
            log::info!("[READING] Deactivated (verses cleared)");
        }
        self.active = false;
        self.verses.clear();
        self.range_end = None;
    }

    /// Run one final transcript through reading mode: (re)start on a fresh
    /// direct detection, follow chapter navigation, then track the reading.
    ///
    /// `direct_hit` is the reference direct detection emitted for this
    /// utterance, if any; `mentioned_books` are the book numbers it names.
    /// `load_chapter(book, chapter)` fetches a chapter's verses. Returns the
    /// verse to present when reading mode moved — a restart from
    /// `direct_hit` returns `None`, since the detection itself presents it.
    pub fn process(
        &mut self,
        transcript: &str,
        direct_hit: Option<&crate::VerseRef>,
        mentioned_books: &[i32],
        load_chapter: &mut dyn FnMut(i32, i32) -> Option<Vec<ChapterVerse>>,
    ) -> Option<ReadingAdvance> {
        // Restart on a new explicit reference, unless it's the book and
        // chapter already being followed.
        if let Some(hit) = direct_hit {
            let same_passage = self.active
                && self.book_number == hit.book_number
                && self.chapter == hit.chapter;
            if !same_passage {
                if let Some(verses) = load_chapter(hit.book_number, hit.chapter) {
                    self.start_passage(
                        hit.book_number,
                        &hit.book_name,
                        hit.chapter,
                        hit.verse_start,
                        hit.verse_end,
                        verses,
                    );
                    // "Genesis chapter" → pause → "5" goes to chapter 5.
                    let lower = transcript.to_lowercase();
                    if lower.contains("chapter") && !lower.contains("next") && !lower.contains("previous") {
                        self.set_expecting_chapter();
                    }
                }
            }
        }

        if !self.active && !self.has_verses() {
            return None;
        }

        // An utterance naming a different book is a spoken reference, not
        // in-book navigation; its numbers must not be read against this
        // book (issue #141: "Revelation chapter 20 verse 22" while reading
        // Hebrews 12 presented Hebrews 12:22).
        if !mentioned_books.is_empty() && !mentioned_books.contains(&self.book_number) {
            log::info!("[READING] Skipping — utterance names a different book than the one being read");
            return None;
        }

        log::info!("[READING] Checking chapter command for: {transcript:?}");
        if let Some((change, verses)) = self
            .check_chapter_command(transcript)
            // "chapter 2, verse 12 to 14" is also a direct detection, which
            // already started this passage — with its range, which a restart
            // from here would drop.
            .filter(|change| {
                direct_hit.is_none_or(|hit| {
                    (hit.book_number, hit.chapter, Some(hit.verse_start))
                        != (change.book_number, change.new_chapter, change.start_verse)
                })
            })
            .and_then(|change| Some((change.clone(), load_chapter(change.book_number, change.new_chapter)?)))
            .filter(|(_, verses)| !verses.is_empty())
        {
            let start_verse = change.start_verse.unwrap_or(1);
            // Never present a verse the chapter doesn't have (issue #141).
            let Some(start_text) = verses.iter().find(|v| v.verse == start_verse).map(|v| v.text.clone()) else {
                log::warn!(
                    "[READING] Ignoring chapter change — verse {start_verse} not in {} {}",
                    change.book_name,
                    change.new_chapter
                );
                return None;
            };
            self.start_passage(
                change.book_number,
                &change.book_name,
                change.new_chapter,
                start_verse,
                None,
                verses,
            );
            return Some(ReadingAdvance {
                book_number: change.book_number,
                book_name: change.book_name.clone(),
                chapter: change.new_chapter,
                verse: start_verse,
                verse_text: start_text,
                reference: format!("{} {}:{start_verse}", change.book_name, change.new_chapter),
                confidence: 1.0,
            });
        }

        self.check_transcript(transcript)
    }

    /// Check if the transcript contains a chapter navigation command.
    ///
    /// Recognises "chapter N", "next chapter", and "previous chapter" anywhere
    /// in the text. Returns `Some(ChapterChange)` when a different chapter is
    /// requested, `None` otherwise.
    ///
    /// Also sets bare_number_context when "chapter" keyword is detected without a number.
    pub fn check_chapter_command(&mut self, text: &str) -> Option<ChapterChange> {
        if self.verses.is_empty() {
            return None;
        }

        let lower = text.to_lowercase();
        let trimmed = lower.trim();

        // Check if text contains "chapter" keyword without a number following it
        // This sets context for the next bare number to be interpreted as chapter
        // BUT exclude "next chapter" and "previous chapter" commands
        if !trimmed.contains("next") && !trimmed.contains("previous") {
            if (trimmed.contains("chapter") && trimmed.ends_with("chapter")) || trimmed.ends_with("chapter?") || trimmed.ends_with("chapter.") {
                log::info!("[READING] Detected 'chapter' keyword without number - expecting chapter number next");
                self.bare_number_context = BareNumberContext::ExpectingChapter;
                return None; // No navigation yet, just set context
            }
        }

        // Check for bare number(s) when expecting chapter or verse
        if self.bare_number_context != BareNumberContext::None {
            if let Some((first_num, rest)) = parse_number_and_rest(trimmed) {
                let rest_trimmed = rest.trim();

                match self.bare_number_context {
                    BareNumberContext::ExpectingChapter => {
                        // Check if there's a second number (e.g., "5 2" → chapter 5 verse 2)
                        if let Some((second_num, rest_after_second)) = parse_number_and_rest(rest_trimmed) {
                            if rest_after_second.trim().is_empty() {
                                log::info!("[READING] Two numbers '{first_num} {second_num}' interpreted as chapter:verse (context: ExpectingChapter)");
                                self.bare_number_context = BareNumberContext::None;
                                return Some(ChapterChange {
                                    book_number: self.book_number,
                                    book_name: self.book_name.clone(),
                                    new_chapter: first_num,
                                    start_verse: Some(second_num),
                                });
                            }
                        }
                        // Single number - just chapter
                        else if rest_trimmed.is_empty() {
                            log::info!("[READING] Bare number {first_num} interpreted as chapter (context: ExpectingChapter)");
                            self.bare_number_context = BareNumberContext::ExpectingVerse;
                            return Some(ChapterChange {
                                book_number: self.book_number,
                                book_name: self.book_name.clone(),
                                new_chapter: first_num,
                                start_verse: Some(1),
                            });
                        }
                    }
                    BareNumberContext::ExpectingVerse => {
                        // Single number only when expecting verse
                        if rest_trimmed.is_empty() {
                            log::info!("[READING] Bare number {first_num} interpreted as verse (context: ExpectingVerse)");
                            self.bare_number_context = BareNumberContext::None;
                            // Return None to let check_verse_number_reference handle it
                            return None;
                        }
                    }
                    BareNumberContext::None => {}
                }
            }
        }

        // "next chapter"
        if trimmed == "next chapter" || trimmed == "next chapter." {
            let new_chapter = self.chapter + 1;
            log::info!("[READING] 'Next chapter' command detected → chapter {new_chapter}");
            return Some(ChapterChange {
                book_number: self.book_number,
                book_name: self.book_name.clone(),
                new_chapter,
                start_verse: None,
            });
        }

        // "previous chapter"
        if trimmed == "previous chapter" || trimmed == "previous chapter." {
            if self.chapter > 1 {
                let new_chapter = self.chapter - 1;
                log::info!("[READING] 'Previous chapter' command detected → chapter {new_chapter}");
                return Some(ChapterChange {
                    book_number: self.book_number,
                    book_name: self.book_name.clone(),
                    new_chapter,
                    start_verse: None,
                });
            }
            return None;
        }

        // "chapter N" or "chapter N verse M" or "N verse M" anywhere in text
        log::debug!("[READING] Attempting to extract chapter and verse from: {:?}", trimmed);
        let (chapter_num, verse_num) = extract_chapter_and_verse(trimmed)?;
        log::debug!("[READING] Extracted: chapter={}, verse={:?}", chapter_num, verse_num);

        // Ignore if it's the same chapter we're already in AND no specific verse
        if chapter_num == self.chapter && verse_num.is_none() {
            log::debug!("[READING] Ignoring same chapter {} without specific verse", chapter_num);
            return None;
        }

        if let Some(verse) = verse_num {
            log::info!("[READING] Chapter change command detected: chapter {chapter_num} verse {verse}");
            // Reset context after full chapter:verse navigation
            self.bare_number_context = BareNumberContext::None;
        } else {
            log::info!("[READING] Chapter change command detected: chapter {chapter_num}");
            // After navigating to a chapter, expect verse next
            self.bare_number_context = BareNumberContext::ExpectingVerse;
        }

        Some(ChapterChange {
            book_number: self.book_number,
            book_name: self.book_name.clone(),
            new_chapter: chapter_num,
            start_verse: verse_num,
        })
    }

    /// Process a transcript fragment and check if the reader has advanced.
    ///
    /// Returns `Some(ReadingAdvance)` if the reader has moved to a new verse.
    /// Returns `None` if still on the current verse or no match found.
    ///
    /// Automatically deactivates after timeout.
    pub fn check_transcript(&mut self, text: &str) -> Option<ReadingAdvance> {
        if !self.active || self.verses.is_empty() {
            return None;
        }

        // Check timeout — but don't clear verses, just pause.
        // This allows "verse N" references to re-activate.
        if self.last_match_time.elapsed().as_millis() > READING_MODE_TIMEOUT_MS
            && self.active
        {
            log::info!("[READING] Timeout — pausing (toggle still on, verses retained)");
            self.active = false;
        }

        // Check for explicit verse number references like "verse three", "verse 4".
        // This works even when paused (timed out) — it re-activates reading mode.
        if !self.verses.is_empty() {
            if let Some(advance) = self.check_verse_number_reference(text) {
                self.active = true; // Re-activate if paused
                return Some(advance);
            }
        }

        if !self.active {
            return None;
        }

        self.follow_reading(text, false)
    }

    /// Follow the reading on a partial (interim) transcript, so the screen
    /// can move seconds before the final arrives. Only follows forward
    /// through the passage — commands and restarts wait for the final, which
    /// would otherwise act on them twice.
    pub fn process_partial(&mut self, transcript: &str, mentioned_books: &[i32]) -> Option<ReadingAdvance> {
        if !self.active || self.verses.is_empty() {
            return None;
        }
        if !mentioned_books.is_empty() && !mentioned_books.contains(&self.book_number) {
            return None;
        }
        self.follow_reading(transcript, true)
    }

    /// Score the utterance against the current verse and the next few, and
    /// move to a later verse only when it clearly fits better.
    ///
    /// Moves happen on the opening words of the next verse rather than the
    /// closing words of the current one: after a verse ends a preacher
    /// often stops to comment, and that commentary must not move the screen.
    /// Content never moves backward — re-reading a verse holds it, and only
    /// an explicit "verse N" goes back.
    ///
    /// `interim` marks a partial transcript, whose words can still change:
    /// it needs a stronger match, never relocates, and leaves the look-back
    /// to the final that follows.
    fn follow_reading(&mut self, text: &str, interim: bool) -> Option<ReadingAdvance> {
        let words = content_words(text);
        if words.is_empty() {
            return None;
        }
        // Fragments are short, so an unresolved previous fragment is read
        // together with this one (see `previous_words`).
        let spoken: Vec<String> = self.previous_words.iter().chain(&words).cloned().collect();
        let score = |verse: &LoadedVerse| {
            verse.texts.iter().map(|t| in_order_score(&spoken, t, &self.weights)).fold(0.0, f64::max)
        };

        let current_score = score(self.verses.get(self.current_index)?);
        if current_score >= MIN_MATCH_SCORE {
            self.last_match_time = Instant::now();
        }

        // (index, raw score, score after the skip penalty)
        let mut best: Option<(usize, f64, f64)> = None;
        for skip in 0..LOOKAHEAD_VERSES {
            let index = self.current_index + 1 + skip;
            let Some(verse) = self.verses.get(index) else { break };
            let raw = score(verse);
            #[expect(clippy::cast_precision_loss, reason = "skip is at most LOOKAHEAD_VERSES")]
            let adjusted = raw / (1.0 + SKIP_PENALTY * skip as f64);
            let past_range = self.range_end.is_some_and(|end| verse.verse_number > end);
            let needed = MIN_MATCH_SCORE
                * if past_range { PAST_RANGE_FACTOR } else { 1.0 }
                * if interim { INTERIM_FACTOR } else { 1.0 };
            if adjusted >= needed && raw > current_score + ADVANCE_MARGIN && best.is_none_or(|(_, _, b)| adjusted > b) {
                best = Some((index, raw, adjusted));
            }
        }

        // Lost: the reader is plainly reading a verse outside the lookahead —
        // started somewhere other than the spoken reference ("14 to 16",
        // then reads from verse 9), or went back. It takes a long in-order
        // match, well above a normal move, so commentary echoing a phrase
        // from elsewhere in the chapter can't trigger it.
        if best.is_none() && !interim && current_score < MIN_MATCH_SCORE {
            let window = self.current_index..=self.current_index + LOOKAHEAD_VERSES;
            let elsewhere = self
                .verses
                .iter()
                .enumerate()
                .filter(|(i, _)| !window.contains(i))
                .map(|(i, verse)| (i, score(verse)))
                .max_by(|a, b| a.1.total_cmp(&b.1));
            if let Some((index, raw)) = elsewhere.filter(|&(_, raw)| raw >= RELOCATE_SCORE) {
                log::info!(
                    "[READING] Relocating: verse {} scored {raw:.2}, current verse {} at {current_score:.2}",
                    self.verses[index].verse_number,
                    self.verses[self.current_index].verse_number,
                );
                let advance = self.advance_to(index);
                self.previous_words = words;
                return advance;
            }
        }

        let Some((index, raw, _)) = best else {
            if interim {
                return None;
            }
            // Words that plainly continue the current verse are settled;
            // anything else may be the opening of the next one.
            let best_later = (1..=LOOKAHEAD_VERSES)
                .filter_map(|ahead| self.verses.get(self.current_index + ahead))
                .map(score)
                .fold(0.0, f64::max);
            if current_score >= MIN_MATCH_SCORE && current_score >= best_later {
                self.previous_words.clear();
            } else {
                self.previous_words = words;
            }
            return None;
        };
        log::info!(
            "[READING] Following: verse {} scored {raw:.2} vs current verse {} at {current_score:.2}",
            self.verses[index].verse_number,
            self.verses[self.current_index].verse_number,
        );
        let advance = self.advance_to(index);
        // This utterance already belongs to the new verse. (A partial's
        // words come again in its final.)
        if !interim {
            self.previous_words = words;
        }
        advance
    }

    /// Check if the transcript contains a verse navigation command:
    /// - "verse three", "verse 4" → jump to that verse
    /// - "next" / "next verse" → advance by 1
    /// - "previous verse" / "go back" / go back by 1
    /// - Bare numbers when context is ExpectingVerse
    fn check_verse_number_reference(&mut self, text: &str) -> Option<ReadingAdvance> {
        let lower = text.to_lowercase();
        let trimmed = lower.trim();

        // If we're expecting a verse number and this is a bare number, interpret it as verse
        if self.bare_number_context == BareNumberContext::ExpectingVerse {
            if let Some((num, rest)) = parse_number_and_rest(trimmed) {
                if rest.trim().is_empty() {
                    log::info!("[READING] Bare number {num} interpreted as verse (context: ExpectingVerse)");
                    self.bare_number_context = BareNumberContext::None;
                    // Navigate to this verse
                    for (idx, v) in self.verses.iter().enumerate() {
                        if v.verse_number == num {
                            return self.advance_to(idx);
                        }
                    }
                    log::warn!("[READING] Verse {} not found in loaded verses", num);
                    return None;
                }
            }
        }

        // Check for "next" / "next verse" command
        if trimmed == "next" || trimmed == "next." || trimmed == "next verse"
            || trimmed == "next verse." {
            let next_idx = self.current_index + 1;
            if next_idx < self.verses.len() {
                log::info!("[READING] 'Next' command detected");
                return self.advance_to(next_idx);
            }
            return None;
        }

        // Check for "previous" / "go back" command
        if trimmed == "previous verse" || trimmed == "previous verse."
            || trimmed == "go back" || trimmed == "go back." {
            if self.current_index > 0 {
                let prev_idx = self.current_index - 1;
                log::info!("[READING] 'Previous' command detected");
                return self.advance_to(prev_idx);
            }
            return None;
        }

        // Strip Deepgram stutters: "verse verse four" → "verse four"
        let cleaned = trimmed
            .replace("verse verse ", "verse ")
            .replace("verses verses ", "verses ");

        // Try to extract a verse number from patterns like "verse N", "verse N."
        let verse_num = extract_verse_number(&cleaned)?;

        // Find this verse number in our loaded verses (allow forward AND backward)
        for (idx, v) in self.verses.iter().enumerate() {
            if v.verse_number == verse_num {
                log::info!("[READING] Verse number reference detected: verse {verse_num}");
                return self.advance_to(idx);
            }
        }

        None
    }

    /// Advance to a new verse index and return the advance event.
    fn advance_to(&mut self, index: usize) -> Option<ReadingAdvance> {
        let verse = self.verses.get(index)?;
        let verse_number = verse.verse_number;
        let verse_text = verse.text.clone();

        self.current_index = index;
        self.previous_words.clear();
        self.last_match_time = Instant::now();

        let reference = format!("{} {}:{verse_number}", self.book_name, self.chapter);
        log::info!("[READING] Advanced to: {reference}");

        Some(ReadingAdvance {
            book_number: self.book_number,
            book_name: self.book_name.clone(),
            chapter: self.chapter,
            verse: verse_number,
            verse_text,
            reference,
            confidence: 1.0, // We'll refine this later
        })
    }
}

impl Default for ReadingMode {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract a verse number from text containing "verse N" anywhere.
///
/// Matches phrases like "let's go to verse five", "give me verse 4",
/// "verse three", or bare SINGLE numbers like "3." or "five".
///
/// Returns None for two-number patterns like "5 2" or "five two" which
/// should be handled as "chapter 5 verse 2" by check_chapter_command.
fn extract_verse_number(text: &str) -> Option<i32> {
    // Find "verse N" or "verses N" anywhere in the text
    for keyword in &["verse ", "verses "] {
        if let Some(pos) = text.find(keyword) {
            let rest = &text[pos + keyword.len()..];
            return parse_number_token(rest);
        }
    }

    // Keep "first N" as a prefix-only match
    if let Some(rest) = text.strip_prefix("first ") {
        return parse_number_token(rest);
    }

    // Check for two-number pattern: "5 2" or "five two" → should be chapter:verse
    // Don't treat this as a bare verse number
    if let Some((first_num, rest_after_first)) = parse_number_and_rest(text) {
        let rest_trimmed = rest_after_first.trim_start();
        // If there's another number after the first, this is likely "chapter verse"
        if let Some((_second_num, _)) = parse_number_and_rest(rest_trimmed) {
            log::debug!("[READING] Found two numbers '{} {}...' - deferring to chapter command handler",
                first_num, rest_trimmed.split_whitespace().next().unwrap_or(""));
            return None; // Let check_chapter_command handle it
        }
        // Only a number standing alone ("26.") is a verse. A leading number
        // followed by words is part of something else — "1 John 2" must not
        // jump to verse 1.
        if rest_trimmed.trim_end_matches(['.', ',', '?', '!']).is_empty() {
            return Some(first_num);
        }
    }

    None
}

/// Parse a number (digit or spoken word) from the start of `text`.
fn parse_number_token(text: &str) -> Option<i32> {
    let trimmed = text.trim_end_matches(['.', ',', '?', '!']);
    // Try digit
    let token: String = trimmed.chars().take_while(|c| c.is_alphanumeric()).collect();
    if let Ok(n) = token.parse::<i32>() {
        if n > 0 && n <= 176 {
            return Some(n);
        }
    }
    // Try spoken number
    let word: String = trimmed.chars().take_while(|c| c.is_alphabetic()).collect();
    if !word.is_empty() {
        if let Some(n) = parse_spoken_number(&word) {
            if n > 0 && n <= 176 {
                return Some(n);
            }
        }
    }
    None
}

/// Extract both chapter and optional verse from patterns like:
/// - "chapter 3" → (3, None)
/// - "chapter 3 verse 5" → (3, Some(5))
/// - "3 verse 5" → (3, Some(5))
fn extract_chapter_and_verse(text: &str) -> Option<(i32, Option<i32>)> {
    // First try to find "chapter N"
    if let Some(pos) = text.find("chapter ") {
        let rest = &text[pos + "chapter ".len()..];
        log::debug!("[EXTRACT] Found 'chapter', rest: {:?}", rest);
        if let Some((chapter, rest_after_chapter)) = parse_number_and_rest(rest) {
            log::debug!("[EXTRACT] Parsed chapter={}, rest_after_chapter: {:?}", chapter, rest_after_chapter);
            // Now check if there's "verse M" after the chapter
            if let Some(verse_pos) = rest_after_chapter.find("verse ") {
                let verse_rest = &rest_after_chapter[verse_pos + "verse ".len()..];
                log::debug!("[EXTRACT] Found 'verse' at pos {}, verse_rest: {:?}", verse_pos, verse_rest);
                if let Some((verse, _)) = parse_number_and_rest(verse_rest) {
                    log::debug!("[EXTRACT] Parsed verse={}", verse);
                    return Some((chapter, Some(verse)));
                } else {
                    log::debug!("[EXTRACT] Failed to parse verse number from: {:?}", verse_rest);
                }
            } else {
                log::debug!("[EXTRACT] No 'verse ' keyword found in: {:?}", rest_after_chapter);
            }
            return Some((chapter, None));
        }
    }

    // Also try pattern without "chapter" keyword: "3 verse 5"
    if let Some((chapter, rest_after_number)) = parse_number_and_rest(text) {
        log::debug!("[EXTRACT] Number-first pattern: chapter={}, rest: {:?}", chapter, rest_after_number);
        if let Some(verse_pos) = rest_after_number.find("verse ") {
            let verse_rest = &rest_after_number[verse_pos + "verse ".len()..];
            if let Some((verse, _)) = parse_number_and_rest(verse_rest) {
                return Some((chapter, Some(verse)));
            }
        }
    }

    None
}

/// Parse a number at the start of text and return both the number and remaining text
fn parse_number_and_rest(text: &str) -> Option<(i32, &str)> {
    let trimmed = text.trim_start();

    // Try digit number first
    if let Some(captures) = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<i32>().ok() {
        let consumed_len = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
        return Some((captures, &trimmed[consumed_len..]));
    }

    // Try spoken number
    let first_word = trimmed.split_whitespace().next()?;
    // Strip punctuation from the word before parsing as spoken number
    let clean_word: String = first_word.chars().filter(|c| c.is_alphabetic()).collect();
    if let Some(num) = parse_spoken_number(&clean_word) {
        let rest = &trimmed[first_word.len()..];

        // Check for compound spoken numbers like "thirty two"
        if num >= 20 && num % 10 == 0 {
            let rest_trimmed = rest.trim_start();
            if let Some(second_word) = rest_trimmed.split_whitespace().next() {
                let clean_second: String = second_word.chars().filter(|c| c.is_alphabetic()).collect();
                if let Some(ones) = parse_spoken_number(&clean_second) {
                    if (1..=9).contains(&ones) {
                        let combined = num + ones;
                        let rest_after_second = &rest_trimmed[second_word.len()..];
                        return Some((combined, rest_after_second));
                    }
                }
            }
        }

        return Some((num, rest));
    }

    None
}

/// Function words (modern and KJV) that carry no verse identity.
const STOPWORDS: &[&str] = &[
    "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "art", "as", "at",
    "be", "because", "been", "before", "being", "but", "by", "can", "could", "did", "do", "doth",
    "even", "for", "from", "had", "has", "hast", "hath", "have", "he", "her", "here", "hers", "him",
    "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "let", "may", "me", "might",
    "mine", "more", "my", "no", "nor", "not", "now", "o", "of", "oh", "on", "one", "or", "our",
    "out", "own", "shall", "she", "should", "so", "such", "than", "that", "the", "thee", "their",
    "them", "then", "there", "these", "they", "thine", "this", "those", "thou", "thy", "to", "unto",
    "up", "upon", "us", "very", "was", "we", "were", "what", "when", "where", "which", "while",
    "who", "whom", "why", "will", "with", "would", "ye", "yea", "yes", "yet", "you", "your",
];

/// Lowercased, lightly stemmed content words of `text`, in order.
fn content_words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric() && c != '\'' && c != '\u{2019}')
        .map(|w| w.to_lowercase().replace(['\'', '\u{2019}'], ""))
        .filter(|w| w.len() >= 2 && !w.chars().all(|c| c.is_ascii_digit()))
        .filter(|w| !STOPWORDS.contains(&w.as_str()))
        .map(|w| stem(&w))
        .collect()
}

/// Fold common inflections so "lights"/"light", "believeth"/"believed"/
/// "believe" and "separated"/"separate" compare equal. Deliberately crude:
/// both sides go through the same function, so it only has to be
/// consistent, not linguistically right.
fn stem(word: &str) -> String {
    let mut w = word;
    for suffix in ["eth", "est", "ing", "ed", "es", "s"] {
        if w.len() > suffix.len() + 2 {
            if let Some(stripped) = w.strip_suffix(suffix) {
                // "glass" and "witness" keep their double s.
                if !(suffix == "s" && stripped.ends_with('s')) {
                    w = stripped;
                    break;
                }
            }
        }
    }
    w.strip_suffix('e').filter(|s| s.len() >= 3).unwrap_or(w).to_string()
}

/// Weight of each word by how few verses of the chapter use it: a word
/// unique to one verse weighs 1.0; one in every verse weighs little.
fn word_weights(verses: &[LoadedVerse]) -> HashMap<String, f64> {
    let mut verse_counts: HashMap<String, usize> = HashMap::new();
    for verse in verses {
        let unique: HashSet<&String> = verse.texts.iter().flatten().collect();
        for word in unique {
            *verse_counts.entry(word.clone()).or_default() += 1;
        }
    }
    #[expect(clippy::cast_precision_loss, reason = "verse counts are small")]
    let n = verses.len() as f64;
    verse_counts
        .into_iter()
        .map(|(word, count)| {
            #[expect(clippy::cast_precision_loss, reason = "verse counts are small")]
            let weight = (1.0 + n / count as f64).ln() / (1.0 + n).ln();
            (word, weight)
        })
        .collect()
}

/// Weighted longest common subsequence of `spoken` and `verse`: the total
/// weight of the words they share in the same order. Order is what tells
/// apart neighbouring verses built from the same words.
fn in_order_score(spoken: &[String], verse: &[String], weights: &HashMap<String, f64>) -> f64 {
    let mut row = vec![0.0_f64; verse.len() + 1];
    for word in spoken {
        let weight = weights.get(word).copied().unwrap_or(0.0);
        let mut diagonal = 0.0;
        for (j, verse_word) in verse.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if word == verse_word { diagonal + weight } else { above.max(row[j]) };
            diagonal = above;
        }
    }
    row[verse.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_verses() -> Vec<(i32, String)> {
        vec![
            (28, "For it seemed good to the Holy Ghost, and to us, to lay upon you no greater burden than these necessary things;".to_string()),
            (29, "That ye abstain from meats offered to idols, and from blood, and from things strangled, and from fornication: from which if ye keep yourselves, ye shall do well. Fare ye well.".to_string()),
            (30, "So when they were dismissed, they came to Antioch: and when they had gathered the multitude together, they delivered the epistle:".to_string()),
            (31, "Which when they had read, they rejoiced for the consolation.".to_string()),
        ]
    }

    #[test]
    fn test_starts_inactive() {
        let rm = ReadingMode::new();
        assert!(!rm.is_active());
        assert!(rm.current_verse().is_none());
    }

    #[test]
    fn test_start_activates() {
        let mut rm = ReadingMode::new();

        rm.start(44, "Acts", 15, 28, sample_verses());
        assert!(rm.is_active());
        assert_eq!(rm.current_verse(), Some(28));
    }

    #[test]
    fn test_advance_on_next_verse_match() {
        let mut rm = ReadingMode::new();

        rm.start(44, "Acts", 15, 28, sample_verses());

        // Feed text matching verse 28
        let r = rm.check_transcript("it seemed good to the Holy Ghost and to us to lay upon you no greater burden than these necessary things");
        // Still on verse 28 — no advance yet
        assert!(r.is_none());

        // Feed text matching verse 29
        let r = rm.check_transcript("that ye abstain from meats offered to idols and from blood and from things strangled and from fornication");
        assert!(r.is_some());
        let advance = r.unwrap();
        assert_eq!(advance.verse, 29);
        assert_eq!(advance.reference, "Acts 15:29");
    }

    #[test]
    fn test_deactivate() {
        let mut rm = ReadingMode::new();

        rm.start(44, "Acts", 15, 28, sample_verses());
        assert!(rm.is_active());
        rm.deactivate();
        assert!(!rm.is_active());
    }

    #[test]
    fn test_no_match_returns_none() {
        let mut rm = ReadingMode::new();

        rm.start(44, "Acts", 15, 28, sample_verses());

        let r = rm.check_transcript("the weather is nice today and I like coffee");
        assert!(r.is_none());
    }

    #[test]
    fn test_content_words_fold_inflections() {
        assert_eq!(content_words("And the lights"), content_words("light"));
        assert_eq!(content_words("believeth"), content_words("believed"));
        assert_eq!(content_words("separated"), content_words("separate"));
        assert_eq!(content_words("the sea of glass"), vec!["sea", "glass"]);
        assert!(content_words("And so, unto them that were").is_empty());
    }

    #[test]
    fn test_in_order_score_prefers_word_order() {
        let verse = content_words("fathers known young men");
        let weights: HashMap<String, f64> = verse.iter().map(|w| (w.clone(), 1.0)).collect();
        let in_order = in_order_score(&content_words("fathers known young men"), &verse, &weights);
        let shuffled = in_order_score(&content_words("young men known fathers"), &verse, &weights);
        assert!((in_order - 4.0).abs() < 1e-9);
        assert!(shuffled < in_order);
    }

    fn passage(verses: &[(i32, &str, &[&str])]) -> Vec<ChapterVerse> {
        verses
            .iter()
            .map(|(verse, text, alternates)| ChapterVerse {
                verse: *verse,
                text: (*text).to_string(),
                alternates: alternates.iter().map(|a| (*a).to_string()).collect(),
            })
            .collect()
    }

    #[test]
    fn test_follows_alternate_translation_wording() {
        // KJV on screen, the reader uses the NIV.
        let mut rm = ReadingMode::new();
        rm.start_passage(1, "Genesis", 1, 6, None, passage(&[
            (6, "And God said, Let there be a firmament in the midst of the waters", &["And God said, Let there be a vault between the waters to separate water from water"]),
            (7, "And God made the firmament, and divided the waters which were under the firmament", &["So God made the vault and separated the water under the vault from the water above it"]),
            (8, "And God called the firmament Heaven", &["God called the vault sky"]),
        ]));
        let advance = rm.check_transcript("so god made the vault and separated the water under the").unwrap();
        assert_eq!(advance.verse, 7);
        assert!(advance.verse_text.contains("firmament"), "display text stays in the screen's translation");
    }

    #[test]
    fn test_commentary_does_not_follow_past_range_end() {
        let mut rm = ReadingMode::new();
        rm.start_passage(62, "1 John", 2, 14, Some(14), passage(&[
            (14, "I have written to you, fathers, because you have known Him who is from the beginning", &[]),
            (15, "Do not love the world or the things in the world", &[]),
        ]));
        assert_eq!(rm.range_end, None, "a range ending at the start verse is no range");
        rm.start_passage(62, "1 John", 2, 13, Some(14), passage(&[
            (13, "I write to you, fathers, because you have known Him who is from the beginning", &[]),
            (14, "I have written to you, young men, because you are strong, and the word of God abides in you", &[]),
            (15, "Do not love the world or the things in the world", &[]),
        ]));
        assert_eq!(rm.check_transcript("because you are strong and the word of God abides").map(|a| a.verse), Some(14));
        assert!(rm.check_transcript("we love the world in this church").is_none());
        assert_eq!(rm.check_transcript("Do not love the world or the things in the world").map(|a| a.verse), Some(15));
    }

    #[test]
    fn test_from_parallel_groups_translations_per_verse() {
        let row = |translation_id: i64, verse: i32, text: &str| rhema_bible::Verse {
            id: 0,
            translation_id,
            book_number: 1,
            book_name: "Genesis".into(),
            book_abbreviation: "Gen".into(),
            chapter: 1,
            verse,
            text: text.into(),
        };
        let verses = ChapterVerse::from_parallel(
            vec![row(1, 1, "kjv 1"), row(2, 1, "niv 1"), row(3, 1, "esv 1"), row(2, 2, "niv 2"), row(1, 3, "kjv 3")],
            1,
        );
        assert_eq!(verses, vec![
            ChapterVerse { verse: 1, text: "kjv 1".into(), alternates: vec!["niv 1".into(), "esv 1".into()] },
            // Verse 2 is missing from the display translation: dropped.
            ChapterVerse { verse: 3, text: "kjv 3".into(), alternates: vec![] },
        ]);
    }

    #[test]
    fn test_book_number_is_not_a_bare_verse() {
        assert_eq!(extract_verse_number("1 john 2,"), None);
        assert_eq!(extract_verse_number("26."), Some(26));
    }

    // --- Bug fix: extract_verse_number with prefix phrases ---

    #[test]
    fn test_extract_verse_number_with_prefix() {
        assert_eq!(extract_verse_number("let's go to verse five"), Some(5));
        assert_eq!(extract_verse_number("give me verse nine"), Some(9));
        assert_eq!(extract_verse_number("go to verse 4"), Some(4));
        assert_eq!(extract_verse_number("let's go to verse twenty"), Some(20));
    }

    #[test]
    fn test_extract_verse_number_direct() {
        assert_eq!(extract_verse_number("verse eight"), Some(8));
        assert_eq!(extract_verse_number("verse eight,"), Some(8));
        assert_eq!(extract_verse_number("verse 3"), Some(3));
        assert_eq!(extract_verse_number("verse three."), Some(3));
    }

    #[test]
    fn test_extract_verse_number_bare() {
        assert_eq!(extract_verse_number("3."), Some(3));
        assert_eq!(extract_verse_number("12"), Some(12));
    }

    #[test]
    fn test_extract_verse_number_no_match() {
        assert_eq!(extract_verse_number("hello world"), None);
        assert_eq!(extract_verse_number("the weather is nice"), None);
    }

    // --- Bug fix: all chapter verses loaded for backward navigation ---

    #[test]
    fn test_backward_verse_navigation() {
        let mut rm = ReadingMode::new();
        let verses: Vec<(i32, String)> = (1..=10)
            .map(|i| (i, format!("Verse {i} text content here.")))
            .collect();

        rm.start(1, "Genesis", 5, 6, verses);
        assert_eq!(rm.current_verse(), Some(6));

        // Navigate backward to verse 3
        let r = rm.check_transcript("verse three");
        assert!(r.is_some());
        assert_eq!(r.unwrap().verse, 3);
    }

    #[test]
    fn test_start_positions_cursor_at_start_verse() {
        let mut rm = ReadingMode::new();
        let verses: Vec<(i32, String)> = (1..=31)
            .map(|i| (i, format!("Verse {i} text.")))
            .collect();

        rm.start(44, "Acts", 15, 28, verses);
        assert_eq!(rm.current_verse(), Some(28));
    }

    // --- Bug fix: chapter navigation ---

    #[test]
    fn test_chapter_command_detected() {
        let mut rm = ReadingMode::new();
        rm.start(1, "Genesis", 5, 1, vec![(1, "In the beginning.".to_string())]);

        let result = rm.check_chapter_command("let's go to chapter seven");
        assert_eq!(
            result,
            Some(ChapterChange {
                book_number: 1,
                book_name: "Genesis".to_string(),
                new_chapter: 7,
                start_verse: None,
            })
        );
    }

    #[test]
    fn test_chapter_command_with_digit() {
        let mut rm = ReadingMode::new();
        rm.start(1, "Genesis", 5, 1, vec![(1, "Text.".to_string())]);

        let result = rm.check_chapter_command("let's go to chapter 8");
        assert!(result.is_some());
        assert_eq!(result.unwrap().new_chapter, 8);
    }

    #[test]
    fn test_chapter_command_same_chapter_ignored() {
        let mut rm = ReadingMode::new();
        rm.start(1, "Genesis", 5, 1, vec![(1, "Text.".to_string())]);

        let result = rm.check_chapter_command("chapter five");
        assert_eq!(result, None);
    }

    #[test]
    fn test_chapter_command_no_verses_ignored() {
        let mut rm = ReadingMode::new();
        let result = rm.check_chapter_command("chapter seven");
        assert_eq!(result, None);
    }

    #[test]
    fn test_next_chapter_command() {
        let mut rm = ReadingMode::new();
        rm.start(1, "Genesis", 5, 1, vec![(1, "Text.".to_string())]);

        let result = rm.check_chapter_command("next chapter");
        assert!(result.is_some());
        assert_eq!(result.unwrap().new_chapter, 6);
    }

    #[test]
    fn test_previous_chapter_command() {
        let mut rm = ReadingMode::new();
        rm.start(1, "Genesis", 5, 1, vec![(1, "Text.".to_string())]);

        let result = rm.check_chapter_command("previous chapter");
        assert!(result.is_some());
        assert_eq!(result.unwrap().new_chapter, 4);
    }

    #[test]
    fn test_previous_chapter_at_chapter_1() {
        let mut rm = ReadingMode::new();
        rm.start(1, "Genesis", 1, 1, vec![(1, "Text.".to_string())]);

        let result = rm.check_chapter_command("previous chapter");
        assert_eq!(result, None);
    }

    #[test]
    fn test_chapter_verse_command() {
        let mut rm = ReadingMode::new();
        rm.start(1, "Genesis", 1, 1, vec![(1, "In the beginning.".to_string())]);

        let result = rm.check_chapter_command("chapter 3 verse 5");
        assert!(result.is_some());
        let change = result.unwrap();
        assert_eq!(change.new_chapter, 3);
        assert_eq!(change.start_verse, Some(5));
    }

    #[test]
    fn test_number_verse_command() {
        let mut rm = ReadingMode::new();
        rm.start(1, "Genesis", 1, 1, vec![(1, "In the beginning.".to_string())]);

        let result = rm.check_chapter_command("3 verse 5");
        assert!(result.is_some());
        let change = result.unwrap();
        assert_eq!(change.new_chapter, 3);
        assert_eq!(change.start_verse, Some(5));
    }

    #[test]
    fn test_spoken_chapter_verse_command() {
        let mut rm = ReadingMode::new();
        rm.start(1, "Genesis", 1, 1, vec![(1, "In the beginning.".to_string())]);

        let result = rm.check_chapter_command("chapter three verse five");
        assert!(result.is_some());
        let change = result.unwrap();
        assert_eq!(change.new_chapter, 3);
        assert_eq!(change.start_verse, Some(5));
    }

    #[test]
    fn test_extract_chapter_and_verse() {
        assert_eq!(extract_chapter_and_verse("chapter 3"), Some((3, None)));
        assert_eq!(extract_chapter_and_verse("chapter 3 verse 5"), Some((3, Some(5))));
        assert_eq!(extract_chapter_and_verse("3 verse 5"), Some((3, Some(5))));
        assert_eq!(extract_chapter_and_verse("chapter three verse five"), Some((3, Some(5))));
        assert_eq!(extract_chapter_and_verse("chapter three verse five."), Some((3, Some(5))));
        assert_eq!(extract_chapter_and_verse("hello world"), None);
    }

    #[test]
    fn test_extract_verse_number_spoken() {
        // Single numbers should be treated as verses
        assert_eq!(extract_verse_number("five"), Some(5));
        assert_eq!(extract_verse_number("three"), Some(3));
        assert_eq!(extract_verse_number("five?"), Some(5));
        assert_eq!(extract_verse_number("verse five"), Some(5));
        assert_eq!(extract_verse_number("5"), Some(5));

        // Two numbers should return None (defer to chapter command handler)
        assert_eq!(extract_verse_number("five two"), None);
        assert_eq!(extract_verse_number("5 2"), None);
        assert_eq!(extract_verse_number("three five"), None);
        assert_eq!(extract_verse_number("3 5"), None);
    }

    // --- Context-aware navigation tests ---

    #[test]
    fn test_bare_number_as_chapter_after_chapter_keyword() {
        let mut rm = ReadingMode::new();
        let verses: Vec<(i32, String)> = (1..=10)
            .map(|i| (i, format!("Verse {i} text.")))
            .collect();
        rm.start(1, "Genesis", 1, 1, verses);

        // Say "chapter" - sets context to ExpectingChapter
        let result = rm.check_chapter_command("chapter");
        assert_eq!(result, None); // No navigation yet, just context set

        // Now say "5" - should be interpreted as chapter 5
        let result = rm.check_chapter_command("5");
        assert!(result.is_some());
        let change = result.unwrap();
        assert_eq!(change.new_chapter, 5);
        assert_eq!(change.start_verse, Some(1));
    }

    #[test]
    fn test_bare_two_numbers_as_chapter_verse() {
        let mut rm = ReadingMode::new();
        let verses: Vec<(i32, String)> = (1..=10)
            .map(|i| (i, format!("Verse {i} text.")))
            .collect();
        rm.start(1, "Genesis", 1, 1, verses);

        // Say "chapter" - sets context
        let _ = rm.check_chapter_command("chapter");

        // Say "5 2" - should be interpreted as chapter 5 verse 2
        let result = rm.check_chapter_command("5 2");
        assert!(result.is_some());
        let change = result.unwrap();
        assert_eq!(change.new_chapter, 5);
        assert_eq!(change.start_verse, Some(2));
    }

    #[test]
    fn test_spoken_numbers_in_context() {
        let mut rm = ReadingMode::new();
        let verses: Vec<(i32, String)> = (1..=10)
            .map(|i| (i, format!("Verse {i} text.")))
            .collect();
        rm.start(1, "Genesis", 1, 1, verses);

        // Say "chapter" - sets context
        let _ = rm.check_chapter_command("chapter");

        // Say "five" - should be interpreted as chapter 5
        let result = rm.check_chapter_command("five");
        assert!(result.is_some());
        let change = result.unwrap();
        assert_eq!(change.new_chapter, 5);
    }

    #[test]
    fn test_context_resets_after_full_reference() {
        let mut rm = ReadingMode::new();
        let verses: Vec<(i32, String)> = (1..=10)
            .map(|i| (i, format!("Verse {i} text.")))
            .collect();
        rm.start(1, "Genesis", 1, 1, verses);

        // Say "chapter" - sets context
        let _ = rm.check_chapter_command("chapter");

        // Say "chapter 3 verse 5" - full reference should reset context
        let result = rm.check_chapter_command("chapter 3 verse 5");
        assert!(result.is_some());
        let change = result.unwrap();
        assert_eq!(change.new_chapter, 3);
        assert_eq!(change.start_verse, Some(5));

        // Context should be reset to None after full reference
        // Next bare number should be handled by verse navigation
    }
}

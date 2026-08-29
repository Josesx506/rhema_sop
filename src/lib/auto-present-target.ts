import type { DetectionResult } from "@/types"

/**
 * Choose which detection in a batch drives the preview / auto-live display.
 *
 * Takes the detector's most confident reading rather than whichever landed
 * first in the batch. One utterance can yield several direct detections, and
 * batch order is emission order — in issue #152 a spurious match was emitted
 * ahead of the verse the preacher actually named, so the wrong one went on air.
 *
 * References the operator has dismissed are skipped (issue #149): a dismissed
 * detection that still auto-presents would make the dismiss cosmetic.
 *
 * Only auto_queued detections qualify (backend-computed cooldown + confidence
 * check) so a burst of speech right after a verse is read doesn't immediately
 * hijack the live display with a new, possibly spurious, direct match.
 */
export function pickAutoPresentTarget(
  detections: DetectionResult[],
  isDismissed: (verseRef: string) => boolean
): DetectionResult | undefined {
  return detections
    .filter(
      (d) =>
        d.source === "direct" &&
        !d.is_chapter_only &&
        d.auto_queued &&
        !isDismissed(d.verse_ref)
    )
    .reduce<DetectionResult | undefined>(
      (best, d) => (best && best.confidence >= d.confidence ? best : d),
      undefined
    )
}

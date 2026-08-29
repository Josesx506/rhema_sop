import type { Song } from "@/types/songs"

/**
 * Out-of-box sample song: "Amazing Grace" by John Newton (1779).
 * Public domain. Used for testing and demonstration.
 */
export const SAMPLE_SONG: Song = {
  id: "sample-amazing-grace",
  title: "Amazing Grace",
  artist: "John Newton",
  sections: [
    {
      id: "v1",
      label: "Verse 1",
      lines: [
        "Amazing grace! How sweet the sound,",
        "That saved a wretch like me!",
        "I once was lost, but now am found;",
        "Was blind, but now I see.",
      ],
    },
    {
      id: "v2",
      label: "Verse 2",
      lines: [
        "'Twas grace that taught my heart to fear,",
        "And grace my fears relieved;",
        "How precious did that grace appear",
        "The hour I first believed!",
      ],
    },
    {
      id: "v3",
      label: "Verse 3",
      lines: [
        "Through many dangers, toils and snares,",
        "I have already come;",
        "'Tis grace hath brought me safe thus far,",
        "And grace will lead me home.",
      ],
    },
    {
      id: "v4",
      label: "Verse 4",
      lines: [
        "When we've been there ten thousand years,",
        "Bright shining as the sun,",
        "We've no less days to sing God's praise",
        "Than when we'd first begun.",
      ],
    },
  ],
  arrangement: ["v1", "v2", "v3", "v4"],
  linesPerBlock: 0,
  createdAt: 0,
  updatedAt: 0,
}

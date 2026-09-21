// Search rules for Browse Sounds: sort options, page sizes, license labels,
// durations and error text. No DOM.

export const SORT_OPTIONS = [
  ['score', 'Best match'],
  ['rating_desc', 'Highest rated'],
  ['downloads_desc', 'Most downloaded'],
  ['duration_desc', 'Longest'],
  ['duration_asc', 'Shortest'],
  ['created_desc', 'Newest']
]

export const FREESOUND_PAGE_SIZE = 24
// Smaller than Freesound's page - each yt-dlp search call takes a couple of
// real seconds (verified against the real bundled binary), unlike
// Freesound's near-instant API call, so a smaller page keeps infinite
// scroll feeling responsive rather than pausing for a large batch.
export const YOUTUBE_PAGE_SIZE = 12
export const MAX_TAGS_SHOWN = 6
// How much of a video an import downloads now lives in src/domain/settings.js
// as a real, saved setting - the fixed 10-minute cap that used to be here
// meant about five minutes of waiting on every YouTube import.

export const SOURCE_KEYS = ['freesound', 'youtube']

export const LICENSE_LABELS = [
  [/publicdomain\/zero/i, 'CC0'],
  [/licenses\/by-nc-sa/i, 'CC BY-NC-SA'],
  [/licenses\/by-nc/i, 'CC BY-NC'],
  [/licenses\/by-sa/i, 'CC BY-SA'],
  [/licenses\/by\b/i, 'CC BY'],
  [/licenses\/sampling\+/i, 'Sampling+']
]

export function licenseLabel(url) {
  if (!url) return 'Unknown license'
  const match = LICENSE_LABELS.find(([pattern]) => pattern.test(url))
  return match ? match[1] : 'Freesound license'
}

export function formatDuration(seconds) {
  const s = Math.round(seconds ?? 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Strips Electron's IPC wrapping and keeps one readable sentence.
//
// This used to cut at the first "(" as well as the first ".", which quietly
// destroyed every import failure: the app's message read "Couldn't download
// that link directly (<http reason>), and yt-dlp also failed: <the real
// reason>", so a live stream, a removed video and a sign-in wall all landed
// on screen as the same useless "Couldn't download that link directly".
// Only a sentence break ends the message now, and only when another word
// follows it, so a message that simply ends in a full stop keeps it.
export function cleanErrorMessage(err, fallback) {
  const clean = (err?.message || fallback).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim()
  const firstLine = clean.split('\n')[0].trim()
  const firstSentence = /^(.+?[.!?])\s+\S/.exec(firstLine)
  return (firstSentence ? firstSentence[1] : firstLine).trim()
}

export function freshSourceState() {
  return { available: false, enabled: true, page: 0, hasMore: false, loading: false, error: null, generation: 0 }
}


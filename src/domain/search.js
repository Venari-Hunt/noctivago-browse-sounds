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
// Matches AddLinkDialog's own DEFAULT_MAX_MINUTES - same yt-dlp download
// pipeline, same reasoning ("so you don't download a 10h file since you can
// loop and crossfade it on the app").
export const YOUTUBE_DEFAULT_MAX_SECONDS = 10 * 60

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

export function cleanErrorMessage(err, fallback) {
  const clean = (err?.message || fallback).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
  return clean.split(/[.(\n]/)[0].trim()
}

export function freshSourceState() {
  return { available: false, enabled: true, page: 0, hasMore: false, loading: false, error: null, generation: 0 }
}


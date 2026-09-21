// Browse Sounds' own settings: rules and storage, no DOM.
//
// These live in the plugin, not in the app's Settings → Library page, so a
// plugin's options move in and out with the plugin (owner feedback,
// 2026-09-20: "the browse sounds plugin's config is in the app's core
// settings"). They are kept in localStorage rather than a core settings key
// for the same reason - nothing in the app has to know this plugin exists.
//
// The one exception is the YouTube sign-in browser: core's own "Add from
// link" uses the same yt-dlp cookie setting, so it stays a core setting and
// this plugin's page just edits it in place. Duplicating it here would mean
// two values fighting over one download.

export const SETTINGS_KEY = 'noctivago.browse-sounds.settings'

// How much of a video to import. YouTube throttles long uploads to roughly
// playback speed (measured 2026-09-21: ~32 KiB/s, so ten minutes of audio
// really does take about five minutes to fetch), so this is the single
// setting that decides how long an import feels. Short is the sane default
// for ambience you are going to loop anyway.
export const MAX_MINUTES_OPTIONS = [1, 3, 5, 10, 20, 0]
export const DEFAULT_MAX_MINUTES = 3

export const DEFAULTS = {
  maxMinutes: DEFAULT_MAX_MINUTES,
  freesoundEnabled: true,
  youtubeEnabled: true
}

export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const minutes = Number(value.maxMinutes)
  return {
    maxMinutes: MAX_MINUTES_OPTIONS.includes(minutes) ? minutes : DEFAULT_MAX_MINUTES,
    freesoundEnabled: value.freesoundEnabled !== false,
    youtubeEnabled: value.youtubeEnabled !== false
  }
}

// localStorage throws in some contexts and can hold anything, so every read
// falls back to the defaults rather than taking the tab down with it.
export function readSettings(storage = globalThis.localStorage) {
  try {
    return normalizeSettings(JSON.parse(storage?.getItem(SETTINGS_KEY) ?? 'null'))
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeSettings(settings, storage = globalThis.localStorage) {
  const normalized = normalizeSettings(settings)
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(normalized))
  } catch {
    // A rejected write (private mode, full quota) costs the preference, not
    // the import - the caller keeps using the value it just normalized.
  }
  return normalized
}

export function maxMinutesLabel(minutes) {
  if (minutes === 0) return 'The whole video'
  return minutes === 1 ? 'First minute' : `First ${minutes} minutes`
}

// What to tell someone before they wait. YouTube's throttle means the wait
// tracks the length of audio asked for, not the file size, so minutes of
// audio ≈ half that many minutes of waiting at the ~2x real time measured.
export const THROTTLED_SPEED_MULTIPLE = 2

export function estimateImportWait(minutes) {
  if (!(minutes > 0)) return 'as long as the video is long'
  const estimate = minutes / THROTTLED_SPEED_MULTIPLE
  if (estimate < 1) return 'well under a minute'
  return estimate === 1 ? 'about a minute' : `about ${Math.round(estimate)} minutes`
}

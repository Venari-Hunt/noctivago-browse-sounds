// Browse Sounds' own page in the app's Settings window.
//
// It exists because this plugin's only real option - the YouTube sign-in
// browser - used to be findable solely in the app's core Settings → Library
// page, which is the wrong place for a plugin's settings (owner feedback,
// 2026-09-20). Everything that shapes a Browse Sounds import now lives here
// and travels with the plugin.
//
// Framework-free, like a tab: the app hands over an empty element.

import { MAX_MINUTES_OPTIONS, maxMinutesLabel, estimateImportWait } from '../domain/settings.js'

// The same list core's own Library page offers, so the two views of this one
// shared value never disagree about what can be picked.
const COOKIE_BROWSERS = [
  ['none', "Don't sign in"],
  ['chrome', 'Chrome'],
  ['edge', 'Edge'],
  ['firefox', 'Firefox'],
  ['brave', 'Brave']
]

export function createSettingsPage({ api, getSettings, setSettings }) {
  return {
    title: 'Browse Sounds',
    mount: (container) => mountPage(container, { api, getSettings, setSettings }),
    unmount: (container) => container.replaceChildren()
  }
}

function mountPage(container, { api, getSettings, setSettings }) {
  container.innerHTML = `
    <div class="browse-settings">
      <div class="browse-setting">
        <div class="browse-setting-text">
          <span class="browse-setting-name">How much of a YouTube video to import</span>
          <span class="browse-setting-desc" id="browse-setting-length-desc"></span>
        </div>
        <select id="browse-setting-length">
          ${MAX_MINUTES_OPTIONS.map((minutes) => `<option value="${minutes}">${maxMinutesLabel(minutes)}</option>`).join('')}
        </select>
      </div>

      <div class="browse-setting">
        <div class="browse-setting-text">
          <span class="browse-setting-name">YouTube: sign in as</span>
          <span class="browse-setting-desc">YouTube sometimes refuses anonymous downloads. Picking a browser lets an import use that browser's YouTube sign-in — cookies only, never your password, and you must already be signed in there. The app's own "Add from link" uses this same setting.</span>
        </div>
        <select id="browse-setting-cookies">
          ${COOKIE_BROWSERS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
        </select>
      </div>

      <div class="browse-setting">
        <div class="browse-setting-text">
          <span class="browse-setting-name">Search these sources</span>
          <span class="browse-setting-desc">Which sources start switched on. You can still turn either one on or off above the results.</span>
        </div>
        <div class="browse-setting-checks">
          <label><input type="checkbox" id="browse-setting-freesound"> Freesound</label>
          <label><input type="checkbox" id="browse-setting-youtube"> YouTube</label>
        </div>
      </div>
    </div>
  `

  const els = {
    length: container.querySelector('#browse-setting-length'),
    lengthDesc: container.querySelector('#browse-setting-length-desc'),
    cookies: container.querySelector('#browse-setting-cookies'),
    freesound: container.querySelector('#browse-setting-freesound'),
    youtube: container.querySelector('#browse-setting-youtube')
  }

  const settings = getSettings()
  els.length.value = String(settings.maxMinutes)
  els.freesound.checked = settings.freesoundEnabled
  els.youtube.checked = settings.youtubeEnabled
  describeLength(els, settings.maxMinutes)

  els.length.addEventListener('change', () => {
    const maxMinutes = Number(els.length.value)
    setSettings({ maxMinutes })
    describeLength(els, maxMinutes)
  })
  els.freesound.addEventListener('change', () => setSettings({ freesoundEnabled: els.freesound.checked }))
  els.youtube.addEventListener('change', () => setSettings({ youtubeEnabled: els.youtube.checked }))

  // The cookie browser is core's setting, shared with "Add from link", so
  // it's read from and written straight back to the app rather than copied.
  els.cookies.addEventListener('change', () => {
    api.settings.setYtDlpCookiesBrowser(els.cookies.value).catch(() => {})
  })
  api.settings
    .get()
    .then((appSettings) => {
      els.cookies.value = appSettings?.ytDlpCookiesBrowser ?? 'none'
    })
    .catch(() => {
      // Leave it on the first option; changing it still writes through.
    })
}

function describeLength(els, maxMinutes) {
  els.lengthDesc.textContent =
    `YouTube limits how fast long videos download — roughly playback speed — so this is what decides how long an import takes. ` +
    `At this setting, expect ${estimateImportWait(maxMinutes)}. Ambience loops in the app, so a short clip is usually plenty.`
}

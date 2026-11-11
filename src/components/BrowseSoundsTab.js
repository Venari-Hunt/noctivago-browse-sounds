// Browse Sounds - a dedicated tab for internet-sourced sound discovery,
// split out of the old "Search Freesound…" add-sound-menu dialog per the
// owner's own 2026-09-15 direction: browsing/discovering unknown sounds
// needs fundamentally more screen space and richer UI than importing a file
// you already have and know (which is why the old dialog felt "underbaked").
// Local file/folder/watch-folder/record imports explicitly stay in core's
// "+" menu, unchanged - only internet-sourced search moves here.
//
// Two sources, searched together and combined into one grid - the owner's
// own answer (2026-09-15) to "should this be a toggle or combined": "search
// both sources at once, combined, tagged by source." A card's license slot
// says "YouTube" for a video, which is its source tag.
//
// Desktop 2.0 (step 14): the look is the approved mock's `browse`,
// `browse-first` and `browse-fail` screens (Global Management
// design-system/mocks/noctivago-desktop.client.js). Results are the same
// centered card as the Mixer, with a preview button where the knob sits; the
// preview bar sits at the bottom of the tab instead of the shared sticky bar;
// how much of a video to import and the YouTube sign-in sit on the search bar
// (they still live in Settings → Browse Sounds too, same values).
//
// - Freesound: its own search/preview/import plumbing (src/main/freesound/)
//   was already fully built (v0.1.190) - a card grid instead of a cramped
//   modal list, infinite scroll instead of a "Load more" button, a sort
//   picker, and every field the API already returns (tags, description,
//   rating).
// - YouTube (v0.1.206, after a 2026-09-15 research pass - see CLAUDE.md):
//   the official Data API's quota is per-project, not per-user, so this
//   reuses the yt-dlp binary already bundled for "Add from link", which
//   searches with no key and no quota. No in-app audio preview (no cheap
//   streaming preview URL the way Freesound has) - the preview slot and the
//   link button open the real video externally instead. Import reuses the
//   exact same yt-dlp-download pipeline "Add from link" already uses.
//
// Isolation between the two sources is deliberate, not incidental (owner's
// own direction): every YouTube-specific call - availability check, search,
// import - is independently try/caught so a yt-dlp failure never blocks,
// clears, or otherwise affects Freesound's half, and vice versa. Each
// source tracks its own page/loading/hasMore state; the shared grid and
// infinite-scroll sentinel just reflect whichever source(s) still have more.
//
// Self-contained per the plugin sandbox's own rule (can't import outside
// its own directory) - window.noctivago.freesound/ytdlp/library are already
// the full API surface a plugin needs.

import {
  SORT_OPTIONS, FREESOUND_PAGE_SIZE, YOUTUBE_PAGE_SIZE, MAX_TAGS_SHOWN, SOURCE_KEYS, SUGGESTIONS,
  licenseLabel, formatDuration, cleanErrorMessage, freshSourceState,
  libraryKeys, resultKey, isNetworkError, unreachableTitle
} from '../domain/search.js'
import { readSettings, writeSettings, maxMinutesLabel, estimateImportWait, MAX_MINUTES_OPTIONS } from '../domain/settings.js'
import { createSettingsPage } from './SettingsPage.js'
import { icon, PLAY_ICON_SVG, PAUSE_ICON_SVG } from './icons.js'

// The mock's sign-in list, plus Brave, which the app's yt-dlp setting also takes.
const COOKIE_BROWSERS = [
  ['none', 'YouTube: not signed in'],
  ['firefox', 'Sign in as Firefox'],
  ['chrome', 'Sign in as Chrome'],
  ['edge', 'Sign in as Edge'],
  ['brave', 'Sign in as Brave']
]

// Tags on a card: one line, like the Mixer card's chips.
const CARD_TAGS = Math.min(3, MAX_TAGS_SHOWN)

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export default class BrowseSoundsPlugin {
  constructor(app) {
    this.app = app
    this.api = app.noctivago
    this.els = {}
    this.query = ''
    this.sort = 'score'
    this.sources = { freesound: freshSourceState(), youtube: freshSourceState() }
    this.previewAudio = null
    this.previewCard = null
    this.previewSound = null
    // Session-only, like the Remix plugin's own previewVolume - a listening
    // preference, not saved settings.
    this.previewVolume = 1
    this.seekDragging = false
    this.observer = null
    this.requestId = 0
    // YouTube-only (Freesound's API gives a stable cursor): each page is a
    // fresh yt-dlp search re-scraping up through its own end index, so
    // consecutive pages can rank a couple of videos differently between
    // calls, producing the odd repeat at a page boundary. Tracked per
    // search (cleared in search(), not loadMore()).
    this.seenYoutubeIds = new Set()
    this.youtubeImporting = false
    // The card whose import is running, so a second click can point at it
    // instead of doing nothing, and so Cancel knows what to put back.
    this.importingCard = null
    // Freesound and YouTube sounds already in the library, so their cards
    // say "In library" instead of offering a second import.
    this.inLibrary = new Set()
    // This plugin's own saved options (src/domain/settings.js), kept here so
    // every import reads one value rather than a hard-coded constant.
    this.settings = readSettings()
  }

  async onload() {
    this.unregister = this.app.tabs.register({
      id: 'browse-sounds',
      title: 'Browse Sounds',
      mount: (container) => this.mount(container),
      onShow: () => this.refreshLibrary(),
      onHide: () => this.stopPreview()
    })
    // A plugin's options belong to the plugin, not to the app's own Settings
    // → Library page (owner feedback, 2026-09-20).
    this.unregisterSettings = this.app.settings.addPage(
      createSettingsPage({
        api: this.api,
        getSettings: () => this.settings,
        setSettings: (patch) => this.updateSettings(patch)
      })
    )
  }

  async onunload() {
    this.stopPreview()
    this.observer?.disconnect()
    window.removeEventListener('mousemove', this.onWindowMouseMove)
    this.unregisterSettings?.()
    this.unregister?.()
  }

  // Never unload mid-import: a YouTube download can run for minutes and
  // tearing the tab down under it would lose the work with no explanation.
  isBusy() {
    return this.youtubeImporting
  }

  updateSettings(patch) {
    this.settings = writeSettings({ ...this.settings, ...patch })
    if (this.els.length) this.els.length.value = String(this.settings.maxMinutes)
    this.describeImportLength()
    return this.settings
  }

  // The cap an import asks for, in seconds. 0 means "the whole video".
  importMaxSeconds() {
    return this.settings.maxMinutes > 0 ? this.settings.maxMinutes * 60 : 0
  }

  // Says up front how long a YouTube import takes. The wait is the whole
  // reason importing from YouTube felt broken: YouTube throttles long
  // uploads to roughly playback speed.
  describeImportLength() {
    if (!this.els.lengthHint) return
    const { maxMinutes } = this.settings
    this.els.lengthHint.textContent = `A YouTube import at ${maxMinutesLabel(maxMinutes)} takes ${estimateImportWait(maxMinutes)}: YouTube caps the speed on long videos.`
  }

  mount(container) {
    const srcChip = (key, label) => `<button type="button" class="bs-srcchip" data-source-toggle="${key}" aria-pressed="true">${label}</button>`
    container.innerHTML = `
      <div class="bs-tab">
        <div class="bs-tools">
          <input id="browse-query" class="bs-field bs-grow" type="text" placeholder="rain, wind, birds…" aria-label="Search" autocomplete="off" />
          <button id="browse-search-btn" class="bs-b bs-pri" type="button">${icon('search')}Search</button>
        </div>
        <div class="bs-tools bs-sub">
          <span class="bs-dim">Search these sources</span>
          ${srcChip('freesound', 'Freesound')}${srcChip('youtube', 'YouTube')}
          <select id="browse-sort" class="bs-field" aria-label="Sort Freesound results" title="Sorts Freesound results; YouTube results keep their own order">
            ${SORT_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
          </select>
          <select id="browse-length" class="bs-field" aria-label="How much of a YouTube video to import" title="How much of a YouTube video to import">
            ${MAX_MINUTES_OPTIONS.map((minutes) => `<option value="${minutes}">${maxMinutesLabel(minutes)}</option>`).join('')}
          </select>
          <select id="browse-cookies" class="bs-field" aria-label="YouTube: sign in as" title="YouTube: sign in as">
            ${COOKIE_BROWSERS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
          </select>
        </div>

        <p id="browse-unavailable" class="bs-hint hidden"></p>

        <div id="browse-first" class="bs-empty">
          ${icon('headphones', 40)}
          <h2>Find sounds for your mix</h2>
          <p>Search Freesound and YouTube. Added sounds go straight to your library.</p>
          <div class="bs-chips bs-big">${SUGGESTIONS.map((x) => `<button type="button" class="bs-chip" data-suggest="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join('')}</div>
        </div>

        <div id="browse-fail" class="bs-empty hidden">
          ${icon('wifi', 40)}
          <h2 id="browse-fail-title"></h2>
          <p id="browse-fail-text"></p>
          <div class="bs-row">
            <button id="browse-retry" class="bs-b" type="button">${icon('refresh-cw')}Try again</button>
            <button id="browse-to-mixer" class="bs-b bs-ghost" type="button">Back to the mixer</button>
          </div>
        </div>

        <p id="browse-status" class="bs-hint hidden"></p>

        <div id="browse-group" class="bs-group hidden">
          <h2 class="bs-gh">Results<span id="browse-count"></span></h2>
          <div id="browse-results" class="bs-tiles"></div>
        </div>
        <div id="browse-sentinel" class="bs-sentinel hidden"></div>
        <div id="browse-foot" class="hidden">
          <p class="bs-hint">Freesound adds its compressed preview and keeps the credit the license asks for. One import runs at a time.</p>
          <p class="bs-hint" id="browse-length-hint"></p>
        </div>

        <div id="browse-pvbar" class="bs-pvbar hidden">
          <button id="browse-pv-play" class="bs-b bs-play bs-sm" type="button" aria-label="Pause preview">${PAUSE_ICON_SVG}</button>
          <b id="browse-pv-name" class="bs-elli"></b>
          <input id="browse-pv-seek" class="bs-fader" type="range" min="0" max="1000" value="0" style="--p:0%" aria-label="Drag to seek" />
          <span id="browse-pv-time" class="bs-num">0:00 / 0:00</span>
          <span class="bs-dim">${icon('volume-2')}</span>
          <div class="bs-vol"><input id="browse-pv-volume" class="bs-fader" type="range" min="0" max="100" value="100" style="--p:100%" aria-label="Preview volume" /></div>
        </div>
      </div>
    `

    const $ = (sel) => container.querySelector(sel)
    this.els = {
      query: $('#browse-query'),
      sort: $('#browse-sort'),
      length: $('#browse-length'),
      cookies: $('#browse-cookies'),
      searchBtn: $('#browse-search-btn'),
      sourceToggles: { freesound: $('[data-source-toggle="freesound"]'), youtube: $('[data-source-toggle="youtube"]') },
      unavailable: $('#browse-unavailable'),
      first: $('#browse-first'),
      fail: $('#browse-fail'),
      failTitle: $('#browse-fail-title'),
      failText: $('#browse-fail-text'),
      status: $('#browse-status'),
      group: $('#browse-group'),
      count: $('#browse-count'),
      results: $('#browse-results'),
      sentinel: $('#browse-sentinel'),
      foot: $('#browse-foot'),
      lengthHint: $('#browse-length-hint'),
      pvbar: $('#browse-pvbar'),
      pvPlay: $('#browse-pv-play'),
      pvName: $('#browse-pv-name'),
      pvSeek: $('#browse-pv-seek'),
      pvTime: $('#browse-pv-time'),
      pvVolume: $('#browse-pv-volume')
    }

    this.els.length.value = String(this.settings.maxMinutes)
    this.describeImportLength()

    this.els.searchBtn.addEventListener('click', () => this.search())
    this.els.query.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') this.search()
    })
    this.els.sort.addEventListener('change', () => {
      if (this.query) this.search()
    })
    this.els.length.addEventListener('change', () => this.updateSettings({ maxMinutes: Number(this.els.length.value) }))
    this.wireCookieSelect()
    for (const key of SOURCE_KEYS) {
      const chip = this.els.sourceToggles[key]
      chip.addEventListener('click', () => {
        const on = chip.getAttribute('aria-pressed') !== 'true'
        chip.setAttribute('aria-pressed', String(on))
        this.toggleSource(key, on)
      })
    }
    container.querySelectorAll('[data-suggest]').forEach((chip) =>
      chip.addEventListener('click', () => {
        this.els.query.value = chip.dataset.suggest
        this.search()
      })
    )
    $('#browse-retry').addEventListener('click', () => {
      if (this.els.query.value.trim()) this.search()
      else this.showScreen('first')
    })
    $('#browse-to-mixer').addEventListener('click', () => this.showMixer())

    this.wirePreviewBar()

    this.observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) this.loadMore()
    })
    this.observer.observe(this.els.sentinel)

    this.checkAvailability()
    this.refreshLibrary()
  }

  // The sign-in browser is core's setting, shared with "Add from link", so
  // it's read from and written straight back to the app rather than copied.
  wireCookieSelect() {
    const select = this.els.cookies
    select.addEventListener('change', () => {
      this.api.settings?.setYtDlpCookiesBrowser(select.value).catch(() => {})
    })
    Promise.resolve()
      .then(() => this.api.settings?.get())
      .then((appSettings) => {
        const value = appSettings?.ytDlpCookiesBrowser ?? 'none'
        if (COOKIE_BROWSERS.some(([v]) => v === value)) select.value = value
      })
      .catch(() => {})
  }

  // "Back to the mixer" on the offline screen. The plugin API only shows a
  // plugin's own tabs, so this presses the Mixer's tab button.
  showMixer() {
    const button = [...document.querySelectorAll('.tab-button')].find((b) => b.title === 'Mixer')
    button?.click()
  }

  // Which body the tab shows: the first-run suggestions, the offline screen,
  // or the results (with a status line while searching or when empty).
  showScreen(screen) {
    this.els.first.classList.toggle('hidden', screen !== 'first')
    this.els.fail.classList.toggle('hidden', screen !== 'fail')
    const results = screen === 'results'
    if (!results) {
      this.els.status.classList.add('hidden')
      this.els.group.classList.add('hidden')
      this.els.foot.classList.add('hidden')
      this.els.sentinel.classList.add('hidden')
    }
  }

  showFailure(failedKeys) {
    this.stopPreview()
    this.els.failTitle.textContent = unreachableTitle(failedKeys)
    this.els.failText.textContent = 'No connection. Your own sounds still work.'
    this.showScreen('fail')
  }

  // Preview bar at the bottom of the tab: Play/Pause, drag to seek, time,
  // volume (owner inbox, 2026-09-16: "a topbar similar to the one on the
  // remix tab but without the audio editing modules"). Only a Freesound
  // preview drives it; YouTube results have no in-app preview.
  wirePreviewBar() {
    const { pvPlay, pvSeek, pvVolume } = this.els
    pvPlay.addEventListener('click', () => {
      const audio = this.previewAudio
      if (!audio) return
      if (audio.paused) audio.play().then(() => this.applyPreviewPlayState(true)).catch(() => this.stopPreview())
      else {
        audio.pause()
        this.applyPreviewPlayState(false)
      }
    })
    pvSeek.addEventListener('pointerdown', () => (this.seekDragging = true))
    pvSeek.addEventListener('pointerup', () => (this.seekDragging = false))
    pvSeek.addEventListener('input', () => {
      const audio = this.previewAudio
      pvSeek.style.setProperty('--p', `${pvSeek.value / 10}%`)
      if (!audio || !Number.isFinite(audio.duration)) return
      audio.currentTime = (pvSeek.value / 1000) * audio.duration
      this.updatePreviewProgress(true)
    })
    pvSeek.addEventListener('change', () => (this.seekDragging = false))
    pvVolume.addEventListener('input', () => {
      this.previewVolume = Number(pvVolume.value) / 100
      pvVolume.style.setProperty('--p', `${pvVolume.value}%`)
      if (this.previewAudio) this.previewAudio.volume = this.previewVolume
    })
  }

  updatePreviewProgress(fromSeek = false) {
    const { pvSeek, pvTime } = this.els
    if (!pvSeek) return
    const audio = this.previewAudio
    const span = audio && Number.isFinite(audio.duration) ? audio.duration : 0
    const elapsed = audio ? Math.min(Math.max(audio.currentTime, 0), span) : 0
    if (!fromSeek && !this.seekDragging) {
      const value = span > 0 ? Math.round((elapsed / span) * 1000) : 0
      pvSeek.value = String(value)
      pvSeek.style.setProperty('--p', `${value / 10}%`)
    }
    pvTime.textContent = `${formatDuration(elapsed)} / ${formatDuration(span)}`
  }

  applyPreviewPlayState(playing) {
    const btn = this.previewCard?.querySelector('.bs-pv')
    if (btn) {
      btn.innerHTML = icon(playing ? 'pause' : 'play', 24)
      btn.setAttribute('aria-pressed', String(playing))
      btn.title = playing ? 'Stop preview' : 'Preview'
    }
    if (!this.els.pvPlay) return
    this.els.pvPlay.innerHTML = playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG
    this.els.pvPlay.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview')
  }

  // Owner's own follow-up direction (2026-09-16, inbox): "Youtube search as
  // well as freesound search should be toggles" - both sources still render
  // into one shared grid, this is only about whether a source is searched
  // at all. Turning a source off removes its cards immediately; turning it
  // back on with an active query fetches it fresh into the existing grid.
  toggleSource(key, enabled) {
    const s = this.sources[key]
    s.enabled = enabled
    // Its cards are gone from the grid either way - the dedup set must match
    // that, or re-enabling filters out every result as a false duplicate.
    if (key === 'youtube') this.seenYoutubeIds.clear()
    if (!enabled) {
      // Bumping generation invalidates any fetch for this source still in
      // flight - it'll discard its response as stale instead of re-adding cards.
      s.generation += 1
      this.clearSourceCards(key)
      s.hasMore = false
      if (this.query) this.updateStatus()
      this.updateSentinelVisibility()
      return
    }
    if (s.available && this.query) {
      s.page = 0
      this.fetchSource(key, { append: false })
    }
  }

  clearSourceCards(key) {
    for (const el of this.els.results.querySelectorAll(`[data-source="${key}"]`)) {
      if (el === this.previewCard) this.stopPreview()
      el.remove()
    }
  }

  updateSentinelVisibility() {
    this.els.sentinel.classList.toggle('hidden', !SOURCE_KEYS.some((key) => this.sources[key].hasMore))
  }

  // Each source's own availability check is independent - a throwing
  // YouTube check must never stop Freesound's own check from running.
  async checkAvailability() {
    const [freesoundAvailable, youtubeAvailable] = await Promise.all([
      this.api.freesound.isAvailable().catch(() => false),
      Promise.resolve()
        .then(() => this.api.ytdlp?.isSearchAvailable())
        .catch(() => false)
    ])

    this.sources.freesound.available = freesoundAvailable
    this.sources.youtube.available = Boolean(youtubeAvailable)

    const anyAvailable = freesoundAvailable || youtubeAvailable
    this.els.unavailable.classList.toggle('hidden', freesoundAvailable && youtubeAvailable)
    if (!freesoundAvailable && !youtubeAvailable) {
      this.els.unavailable.textContent = "Search isn't available in this build."
    } else if (!freesoundAvailable) {
      this.els.unavailable.textContent = "Freesound import isn't available in this build (no API key baked in). YouTube search still works."
    } else if (!youtubeAvailable) {
      this.els.unavailable.textContent = "YouTube search isn't available in this build. Freesound still works."
    }
    this.els.query.disabled = !anyAvailable
    this.els.searchBtn.disabled = !anyAvailable
    for (const key of SOURCE_KEYS) {
      const chip = this.els.sourceToggles[key]
      chip.disabled = !this.sources[key].available
      // Which sources start on is a saved preference (Settings → Browse
      // Sounds); the chips on the search bar still override it per search.
      const enabled = this.sources[key].available && (key === 'freesound' ? this.settings.freesoundEnabled : this.settings.youtubeEnabled)
      chip.setAttribute('aria-pressed', String(enabled))
      this.sources[key].enabled = enabled
    }
    if (anyAvailable) this.els.query.focus()
  }

  async refreshLibrary() {
    try {
      this.inLibrary = libraryKeys(await this.api.library.list())
    } catch {
      return
    }
    for (const card of this.els.results?.children ?? []) {
      if (card !== this.importingCard && this.inLibrary.has(card.dataset.key) && !card.querySelector('.bs-have')) this.setCardState(card, 'have')
    }
  }

  search() {
    const query = this.els.query.value.trim()
    if (!query) return
    this.stopPreview()
    this.query = query
    this.sort = this.els.sort.value
    this.requestId += 1
    for (const key of SOURCE_KEYS) {
      const s = this.sources[key]
      s.page = 0
      s.total = null
      s.hasMore = s.available && s.enabled
      s.error = null
    }
    this.els.results.replaceChildren()
    this.seenYoutubeIds.clear()

    const queried = SOURCE_KEYS.filter((key) => this.sources[key].available && this.sources[key].enabled)
    // No network at all: say so now instead of waiting for both searches to time out.
    if (queried.length && !navigator.onLine) {
      this.showFailure(queried)
      return
    }
    this.showScreen('results')
    this.updateStatus()
    for (const key of queried) this.fetchSource(key, { append: false })
  }

  loadMore() {
    if (!this.query) return
    for (const key of SOURCE_KEYS) {
      const s = this.sources[key]
      if (s.available && s.enabled && s.hasMore && !s.loading) this.fetchSource(key, { append: true })
    }
  }

  // Isolation (owner's own direction, 2026-09-15): each source is fetched
  // and rendered independently, wrapped in its own try/catch, so a failure
  // in one never wipes or blocks the other source's results already on screen.
  async fetchSource(key, { append }) {
    const s = this.sources[key]
    s.loading = true
    s.page += 1
    this.updateSearchButtonState()

    const requestId = this.requestId
    const generation = s.generation
    let result
    try {
      result = key === 'freesound' ? await this.searchFreesound(s.page) : await this.searchYouTube(s.page)
    } catch (err) {
      result = { ok: false, error: cleanErrorMessage(err, 'Search failed.') }
    }

    if (requestId !== this.requestId) return // superseded by a newer search
    s.loading = false
    this.updateSearchButtonState()

    // Superseded by this same source being toggled off (and possibly back
    // on) since this fetch started. Checked after clearing s.loading above
    // so the search button doesn't stay stuck disabled.
    if (generation !== s.generation) return

    if (!result.ok) {
      s.hasMore = false
      s.error = result.error || 'Search failed.'
      this.updateStatus()
      return
    }

    s.error = null
    if (key === 'freesound' && Number.isFinite(result.count)) s.total = result.count
    if (!append) {
      // A source that returns late (e.g. YouTube's slower search) must not
      // wipe cards the other source already appended - only its own.
      this.clearSourceCards(key)
    }
    for (const sound of result.results) {
      if (key === 'youtube') {
        if (this.seenYoutubeIds.has(sound.id)) continue
        this.seenYoutubeIds.add(sound.id)
      }
      try {
        this.els.results.appendChild(this.renderCard(sound, key))
      } catch (err) {
        console.error('Browse Sounds: failed to render a result card', key, err)
      }
    }
    s.hasMore = Boolean(result.hasMore)
    this.updateStatus()
    this.updateSentinelVisibility()
  }

  async searchFreesound(page) {
    return this.api.freesound.search({ query: this.query, page, sort: this.sort, pageSize: FREESOUND_PAGE_SIZE })
  }

  async searchYouTube(page) {
    return this.api.ytdlp.searchYouTube({ query: this.query, page, pageSize: YOUTUBE_PAGE_SIZE })
  }

  updateSearchButtonState() {
    this.els.searchBtn.disabled = this.sources.freesound.loading || this.sources.youtube.loading
  }

  // "Results 10 of 1,204": Freesound gives its total; YouTube adds what it
  // has shown, with a + while more pages remain.
  countLabel(count) {
    const fs = this.sources.freesound
    const yt = this.sources.youtube
    if (fs.total == null || (!fs.hasMore && !yt.hasMore)) return String(count)
    const youtubeShown = this.els.results.querySelectorAll('[data-source="youtube"]').length
    return `${count} of ${(fs.total + youtubeShown).toLocaleString('en-US')}${yt.hasMore ? '+' : ''}`
  }

  updateStatus() {
    const count = this.els.results.children.length
    const anyLoading = this.sources.freesound.loading || this.sources.youtube.loading
    const setStatus = (text) => {
      this.els.status.textContent = text
      this.els.status.classList.toggle('hidden', !text)
    }
    this.els.group.classList.toggle('hidden', count === 0)
    this.els.foot.classList.toggle('hidden', count === 0)
    if (count > 0) {
      this.els.count.textContent = this.countLabel(count)
      const errors = SOURCE_KEYS.filter((key) => this.sources[key].error).map((key) => `${key === 'freesound' ? 'Freesound' : 'YouTube'}: ${this.sources[key].error}`)
      setStatus(errors.join(' · '))
      return
    }
    if (anyLoading) return setStatus('Searching…')
    const enabled = SOURCE_KEYS.filter((key) => this.sources[key].available && this.sources[key].enabled)
    if (!enabled.length) return setStatus('Turn on at least one source above to search.')
    const failed = enabled.filter((key) => this.sources[key].error)
    // Every source that was asked failed for lack of a connection: the offline screen.
    if (failed.length === enabled.length && failed.every((key) => isNetworkError(this.sources[key].error, navigator.onLine))) {
      this.showFailure(failed)
      return
    }
    setStatus(failed.length ? this.sources[failed[0]].error : `No results for "${this.query}".`)
  }

  stopPreview() {
    if (this.previewAudio) {
      this.previewAudio.pause()
      this.previewAudio.src = ''
      this.previewAudio = null
    }
    this.applyPreviewPlayState(false)
    this.previewCard?.classList.remove('bs-on')
    this.previewCard = null
    this.previewSound = null
    this.els.pvbar?.classList.add('hidden')
    this.updatePreviewProgress()
  }

  togglePreview(sound, card) {
    if (this.previewCard === card) {
      this.stopPreview()
      return
    }
    this.stopPreview()
    const audio = new Audio(`freesound-preview://p/${encodeURIComponent(sound.previewUrl)}`)
    audio.volume = this.previewVolume
    audio.addEventListener('loadedmetadata', () => this.updatePreviewProgress())
    audio.addEventListener('timeupdate', () => this.updatePreviewProgress())
    audio.addEventListener('ended', () => this.stopPreview())
    audio.addEventListener('error', () => this.stopPreview())
    audio.play().catch(() => this.stopPreview())
    this.previewAudio = audio
    this.previewCard = card
    this.previewSound = sound
    card.classList.add('bs-on')
    this.applyPreviewPlayState(true)
    this.els.pvName.textContent = sound.name
    this.els.pvName.title = sound.name
    this.els.pvbar.classList.remove('hidden')
  }

  // A card's bottom slot: Import, In library / Added, or a running download.
  setCardState(card, state, { message = '', percent = null } = {}) {
    const slot = card.querySelector('.bs-state')
    const source = card.dataset.source
    if (state === 'have' || state === 'added') {
      slot.innerHTML = `<div class="bs-have">${icon('check')}${state === 'have' ? 'In library' : 'Added'}</div>`
      card.dataset.imported = 'true'
      return
    }
    if (state === 'busy') {
      slot.innerHTML = `<div class="bs-dl"><div class="bs-sb"><i></i></div><span class="bs-meta"></span>${source === 'youtube' ? '<button type="button" class="bs-b bs-ghost bs-cancel">Cancel</button>' : ''}</div>`
      slot.querySelector('.bs-meta').textContent = message
      const bar = slot.querySelector('.bs-sb')
      bar.classList.toggle('hidden', percent == null)
      if (percent != null) bar.firstElementChild.style.width = `${percent}%`
      slot.querySelector('.bs-cancel')?.addEventListener('click', (evt) => {
        evt.currentTarget.disabled = true
        evt.currentTarget.textContent = 'Cancelling…'
        this.api.library.cancelAddSoundFromUrl?.().catch(() => {})
      })
      return
    }
    const importBtn = `<button type="button" class="bs-b bs-import">${icon('download')}Import</button>`
    slot.innerHTML =
      source === 'youtube'
        ? `<div class="bs-row">${importBtn}<a class="bs-i" href="${escapeHtml(card.dataset.url)}" target="_blank" rel="noopener noreferrer" title="Watch on YouTube" aria-label="Watch on YouTube">${icon('external-link')}</a></div>`
        : importBtn
    slot.querySelector('.bs-import').addEventListener('click', () => (source === 'freesound' ? this.importResult(card) : this.importYouTubeResult(card)))
  }

  // Updates a running download in place, without rebuilding the Cancel button.
  setCardProgress(card, { message, percent = null }) {
    const dl = card.querySelector('.bs-dl')
    if (!dl) return this.setCardState(card, 'busy', { message, percent })
    if (message != null) dl.querySelector('.bs-meta').textContent = message
    const bar = dl.querySelector('.bs-sb')
    bar.classList.toggle('hidden', percent == null)
    if (percent != null) bar.firstElementChild.style.width = `${percent}%`
  }

  setCardMessage(card, text) {
    const msg = card.querySelector('.bs-msg')
    msg.textContent = text
    msg.classList.toggle('hidden', !text)
  }

  async importResult(card) {
    const sound = card._sound
    this.setCardMessage(card, '')
    this.setCardState(card, 'busy', { message: 'Importing…' })
    let unsubscribe = null
    try {
      unsubscribe = this.api.library.onAddSoundFromFreesoundProgress?.((update) => {
        if (update?.message) this.setCardProgress(card, { message: update.message })
      })
    } catch {
      unsubscribe = null
    }
    try {
      await this.api.library.addSoundFromFreesound({
        freesoundId: sound.id,
        name: sound.name,
        username: sound.username,
        license: sound.license,
        pageUrl: sound.pageUrl,
        previewUrl: sound.previewUrl,
        description: sound.description,
        tags: sound.tags
      })
      this.inLibrary.add(card.dataset.key)
      this.setCardState(card, 'added')
      document.dispatchEvent(new CustomEvent('library:linked'))
    } catch (err) {
      this.setCardState(card, 'import')
      this.setCardMessage(card, `Failed: ${cleanErrorMessage(err, 'Import failed')}`)
    } finally {
      unsubscribe?.()
    }
  }

  // yt-dlp downloads take real wall-clock time, unlike Freesound's
  // near-instant preview download - reuses library:addSoundFromUrl's own
  // progress channel to show real status. Only one YouTube import can run
  // at a time (the progress channel is a single global stream with no
  // per-request id), so a second click says so and points at the busy card.
  async importYouTubeResult(card) {
    if (this.youtubeImporting) {
      this.setCardMessage(card, 'Another import is running. One at a time.')
      this.importingCard?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      return
    }
    const sound = card._sound
    this.youtubeImporting = true
    this.importingCard = card
    this.setCardMessage(card, '')
    const { maxMinutes } = this.settings
    this.setCardState(card, 'busy', { message: `Starting… (${maxMinutesLabel(maxMinutes).toLowerCase()}, ${estimateImportWait(maxMinutes)})` })

    const unsubscribe = this.api.library.onAddSoundFromUrlProgress((update) => {
      if (!update) return
      if (update.type === 'progress') {
        const percent = Math.round(update.percent)
        this.setCardProgress(card, { message: `Downloading… ${percent}%`, percent })
      } else if (update.message) {
        this.setCardProgress(card, { message: update.message })
      }
    })

    try {
      await this.api.library.addSoundFromUrl({ url: sound.url, name: sound.title, maxSeconds: this.importMaxSeconds() })
      this.inLibrary.add(card.dataset.key)
      this.setCardState(card, 'added')
      document.dispatchEvent(new CustomEvent('library:linked'))
    } catch (err) {
      this.setCardState(card, 'import')
      this.setCardMessage(card, cleanErrorMessage(err, 'Import failed.'))
    } finally {
      unsubscribe()
      this.youtubeImporting = false
      this.importingCard = null
    }
  }

  renderCard(sound, source) {
    const card = document.createElement('div')
    card.className = 'bs-tile'
    card.dataset.source = source
    card.dataset.key = resultKey(sound, source)
    card._sound = sound
    const title = source === 'freesound' ? sound.name : sound.title

    // The preview button sits where the Mixer card's knob does. A YouTube
    // result has no in-app preview, so its button shows the video's
    // thumbnail and opens the video in the browser.
    let pv
    if (source === 'freesound') {
      pv = document.createElement('button')
      pv.type = 'button'
      pv.title = 'Preview'
      pv.setAttribute('aria-pressed', 'false')
      pv.addEventListener('click', () => this.togglePreview(sound, card))
    } else {
      pv = document.createElement('a')
      pv.href = sound.url
      pv.target = '_blank'
      pv.rel = 'noopener noreferrer'
      pv.title = 'Watch on YouTube'
      if (sound.thumbnailUrl) {
        pv.classList.add('bs-thumb')
        pv.style.backgroundImage = `url("${String(sound.thumbnailUrl).replace(/"/g, '%22')}")`
      }
    }
    pv.classList.add('bs-pv')
    pv.setAttribute('aria-label', `${source === 'freesound' ? 'Preview' : 'Watch'} ${title}`)
    pv.innerHTML = icon('play', 24)

    // Freesound's name links out to the sound's real Freesound page (owner
    // inbox, 2026-09-16); the description shows on hover, as the card has no
    // room for it.
    const name = document.createElement(source === 'freesound' && sound.pageUrl ? 'a' : 'div')
    name.className = 'bs-nm'
    name.textContent = title
    name.title = sound.description ? `${title}\n\n${sound.description}` : title
    if (name.tagName === 'A') {
      name.href = sound.pageUrl
      name.target = '_blank'
      name.rel = 'noopener noreferrer'
    }

    const by = document.createElement('div')
    by.className = 'bs-meta'
    by.textContent = `by ${source === 'freesound' ? sound.username : sound.channel}`

    const meta = document.createElement('div')
    meta.className = 'bs-meta'
    const rating = source === 'freesound' && sound.numRatings > 0 && sound.avgRating != null ? ` · ★${sound.avgRating.toFixed(1)}` : ''
    meta.textContent = `${formatDuration(sound.durationSeconds)} · ${source === 'freesound' ? licenseLabel(sound.license) : 'YouTube'}${rating}`
    if (rating) meta.title = `${sound.avgRating.toFixed(1)} stars from ${sound.numRatings} rating${sound.numRatings === 1 ? '' : 's'}`

    const chips = document.createElement('div')
    chips.className = 'bs-chips'
    const tags = sound.tags ?? []
    for (const tag of tags.slice(0, CARD_TAGS)) {
      const chip = document.createElement('span')
      chip.className = 'bs-chip'
      chip.textContent = tag
      chips.appendChild(chip)
    }
    if (tags.length > CARD_TAGS) {
      const more = document.createElement('span')
      more.className = 'bs-chip bs-more'
      more.textContent = `+${tags.length - CARD_TAGS}`
      more.title = tags.slice(CARD_TAGS).join(', ')
      chips.appendChild(more)
    }

    const state = document.createElement('div')
    state.className = 'bs-state'
    const msg = document.createElement('div')
    msg.className = 'bs-meta bs-msg hidden'

    card.append(pv, name, by, meta, chips, state, msg)
    if (source === 'youtube') card.dataset.url = sound.url
    this.setCardState(card, this.inLibrary.has(card.dataset.key) ? 'have' : 'import')
    return card
  }
}

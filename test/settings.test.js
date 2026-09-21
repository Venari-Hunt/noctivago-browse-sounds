import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS,
  DEFAULT_MAX_MINUTES,
  normalizeSettings,
  readSettings,
  writeSettings,
  maxMinutesLabel,
  estimateImportWait
} from '../src/domain/settings.js'

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    dump: () => Object.fromEntries(map)
  }
}

test('normalizeSettings falls back to the defaults for junk', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULTS)
  assert.deepEqual(normalizeSettings({ maxMinutes: 'seven' }), DEFAULTS)
  // 7 isn't one of the offered lengths.
  assert.equal(normalizeSettings({ maxMinutes: 7 }).maxMinutes, DEFAULT_MAX_MINUTES)
  assert.equal(normalizeSettings({ maxMinutes: 0 }).maxMinutes, 0)
})

test('only an explicit false switches a source off', () => {
  assert.equal(normalizeSettings({}).youtubeEnabled, true)
  assert.equal(normalizeSettings({ youtubeEnabled: false }).youtubeEnabled, false)
  assert.equal(normalizeSettings({ youtubeEnabled: undefined }).youtubeEnabled, true)
})

test('settings round-trip through storage', () => {
  const storage = fakeStorage()
  writeSettings({ maxMinutes: 10, freesoundEnabled: false }, storage)
  const read = readSettings(storage)
  assert.equal(read.maxMinutes, 10)
  assert.equal(read.freesoundEnabled, false)
  assert.equal(read.youtubeEnabled, true)
})

test('unreadable or corrupt storage still yields the defaults', () => {
  assert.deepEqual(readSettings(fakeStorage({ 'noctivago.browse-sounds.settings': '{not json' })), DEFAULTS)
  assert.deepEqual(readSettings(undefined), DEFAULTS)
  const throwing = {
    getItem: () => {
      throw new Error('denied')
    }
  }
  assert.deepEqual(readSettings(throwing), DEFAULTS)
})

test('a rejected write still returns the normalized value', () => {
  const throwing = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota')
    }
  }
  assert.equal(writeSettings({ maxMinutes: 5 }, throwing).maxMinutes, 5)
})

test('labels and wait estimates read like sentences', () => {
  assert.equal(maxMinutesLabel(0), 'The whole video')
  assert.equal(maxMinutesLabel(1), 'First minute')
  assert.equal(maxMinutesLabel(10), 'First 10 minutes')
  assert.equal(estimateImportWait(1), 'well under a minute')
  assert.equal(estimateImportWait(2), 'about a minute')
  assert.equal(estimateImportWait(10), 'about 5 minutes')
  assert.equal(estimateImportWait(0), 'as long as the video is long')
})

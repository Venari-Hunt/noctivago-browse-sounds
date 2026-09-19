import { test } from 'node:test'
import assert from 'node:assert/strict'
import { licenseLabel, formatDuration, cleanErrorMessage, freshSourceState } from '../src/domain/search.js'

test('licenseLabel names Creative Commons licenses from their URL', () => {
  assert.equal(licenseLabel('http://creativecommons.org/publicdomain/zero/1.0/'), 'CC0')
  assert.equal(licenseLabel('https://creativecommons.org/licenses/by-nc/4.0/'), 'CC BY-NC')
  assert.equal(licenseLabel('https://creativecommons.org/licenses/by/4.0/'), 'CC BY')
  assert.equal(licenseLabel('https://example.com/other'), 'Freesound license')
  assert.equal(licenseLabel(''), 'Unknown license')
})

test('formatDuration shows m:ss', () => {
  assert.equal(formatDuration(65.4), '1:05')
  assert.equal(formatDuration(undefined), '0:00')
})

test('cleanErrorMessage strips the IPC wrapper and keeps the first sentence', () => {
  const err = new Error("Error invoking remote method 'freesound:search': Error: Rate limited. Try later")
  assert.equal(cleanErrorMessage(err, 'x'), 'Rate limited')
  assert.equal(cleanErrorMessage(null, 'Search failed'), 'Search failed')
})

test('freshSourceState starts enabled with no pages loaded', () => {
  const s = freshSourceState()
  assert.equal(s.enabled, true)
  assert.equal(s.page, 0)
  assert.notEqual(freshSourceState(), s)
})

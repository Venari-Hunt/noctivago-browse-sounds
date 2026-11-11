import { test } from 'node:test'
import assert from 'node:assert/strict'
import { licenseLabel, formatDuration, cleanErrorMessage, freshSourceState, youtubeVideoId, libraryKeys, resultKey, isNetworkError, unreachableTitle } from '../src/domain/search.js'

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

test('cleanErrorMessage strips the IPC wrapper and keeps one sentence', () => {
  const err = new Error("Error invoking remote method 'freesound:search': Error: Rate limited. Try later")
  assert.equal(cleanErrorMessage(err, 'x'), 'Rate limited.')
  assert.equal(cleanErrorMessage(null, 'Search failed'), 'Search failed')
})

// The regression this function existed to cause: it used to cut at the
// first '(' too, so every import failure read the same.
test('cleanErrorMessage keeps the real reason behind a parenthesis', () => {
  const err = new Error("Couldn't download that link: That's a live stream, so there's no recording to import yet.")
  assert.match(cleanErrorMessage(err, 'x'), /live stream/)
  const legacy = new Error('Failed (direct download), and yt-dlp also failed: video is unavailable')
  assert.match(cleanErrorMessage(legacy, 'x'), /video is unavailable/)
})

test('cleanErrorMessage drops a multi-line tail', () => {
  const err = new Error(['Short reason.', 'ffmpeg noise here'].join(String.fromCharCode(10)))
  assert.equal(cleanErrorMessage(err, 'x'), 'Short reason.')
})

test('freshSourceState starts enabled with no pages loaded', () => {
  const s = freshSourceState()
  assert.equal(s.enabled, true)
  assert.equal(s.page, 0)
  assert.notEqual(freshSourceState(), s)
})

test('formatDuration shows h:mm:ss from an hour up', () => {
  assert.equal(formatDuration(43200), '12:00:00')
  assert.equal(formatDuration(3725), '1:02:05')
  assert.equal(formatDuration(3599), '59:59')
})

test('youtubeVideoId reads every link form', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ')
  assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.equal(youtubeVideoId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.equal(youtubeVideoId('https://example.com/a'), null)
  assert.equal(youtubeVideoId(undefined), null)
})

test('libraryKeys and resultKey match imported sounds to results', () => {
  const keys = libraryKeys([
    { source: { type: 'freesound', freesoundId: 243781 } },
    { source: { type: 'url', url: 'https://youtu.be/dQw4w9WgXcQ' } },
    { source: { type: 'file' } },
    {}
  ])
  assert.equal(keys.size, 2)
  assert.ok(keys.has(resultKey({ id: 243781 }, 'freesound')))
  assert.ok(keys.has(resultKey({ id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, 'youtube')))
  assert.ok(!keys.has(resultKey({ id: 1 }, 'freesound')))
  assert.equal(libraryKeys(null).size, 0)
})

test('isNetworkError tells a dead connection from a refusal', () => {
  assert.ok(isNetworkError('getaddrinfo ENOTFOUND freesound.org'))
  assert.ok(isNetworkError('fetch failed'))
  assert.ok(isNetworkError('Freesound said 401', false))
  assert.ok(!isNetworkError('Freesound said 401'))
})

test('unreachableTitle names what failed', () => {
  assert.equal(unreachableTitle(['freesound']), "Can't reach Freesound")
  assert.equal(unreachableTitle(['freesound', 'youtube']), "Can't reach Freesound or YouTube")
})

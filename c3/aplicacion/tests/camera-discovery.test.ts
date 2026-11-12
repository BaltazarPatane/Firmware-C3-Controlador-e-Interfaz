import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cameraBaseUrl, discoverCamera } from '../lib/camera-discovery'

test('camera follows a DHCP address change without a Marlin status packet', () => {
  assert.equal(cameraBaseUrl({ available: true, baseUrl: 'http://192.168.0.227:80' }), 'http://192.168.0.227')
  assert.equal(cameraBaseUrl({ available: true, baseUrl: 'http://192.168.0.31:80' }), 'http://192.168.0.31')
  assert.equal(cameraBaseUrl({ available: false, baseUrl: '' }), null)
})

test('invalid discovery responses never become an image source', () => {
  for (const baseUrl of ['https://192.168.0.31', 'http://camera.example',
    'http://192.168.0.31/stream', 'http://u:p@192.168.0.31',
    'javascript:alert(1)', 'http://192.168.0.31/?x=1', 'http://192.168.0.31/#x'])
    assert.throws(() => cameraBaseUrl({ available: true, baseUrl }))
  for (const value of [null, {}, { available: true }, '192.168.0.31'])
    assert.throws(() => cameraBaseUrl(value))
})

test('discovery uses same-origin API, no cache and an abort signal', async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/api/camera')
    assert.equal(init?.cache, 'no-store')
    assert.equal(init?.signal, controller.signal)
    return new Response(JSON.stringify({ available: true, baseUrl: 'http://192.168.0.52:80' }))
  }
  try { assert.equal(await discoverCamera(controller.signal), 'http://192.168.0.52') }
  finally { globalThis.fetch = original }
})

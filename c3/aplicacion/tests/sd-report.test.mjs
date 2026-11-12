import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSdDetail, sdFraction, formatSdElapsed } from '../lib/sd-print-report.ts'

test('M27 C current file matches actual Marlin response', () => {
  assert.deepEqual(parseSdDetail('Current file: CASA01.GCO'), {filename:'CASA01.GCO'})
  assert.deepEqual(parseSdDetail('echo:Current file: PROYECTO.GCO'), {filename:'PROYECTO.GCO'})
  assert.equal(parseSdDetail('[Anterior] Current file: VIEJO.GCO'), null)
})
test('M31 elapsed print timer parses the real duration_t format', () => {
  assert.deepEqual(parseSdDetail('echo:Print time: 23h 59m 59s'), {elapsedSeconds:86399})
  assert.deepEqual(parseSdDetail('Print time: 1d 2h 3m 4s'), {elapsedSeconds:93784})
  assert.deepEqual(parseSdDetail('echo:Print time: 59s'), {elapsedSeconds:59})
  assert.equal(parseSdDetail('echo:Print time: ---'), null)
  assert.equal(parseSdDetail('Print time: 13foo'), null)
})
test('M27 byte ratio is not a time-remaining estimate', () => {
  assert.equal(sdFraction(250,1000), 25)
  assert.equal(sdFraction(1200,1000), 100)
  assert.equal(sdFraction(250,0), null)
  assert.equal(sdFraction(-4,200), null)
  assert.equal(formatSdElapsed(null),'—')
  assert.equal(formatSdElapsed(3723),'1 h 2 min 3 s')
})

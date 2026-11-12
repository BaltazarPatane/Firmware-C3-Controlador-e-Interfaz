import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HoldToConfirm } from '../lib/hold-to-confirm'

function rig() {
  let now = 0, next = 0, calls = 0, progress = 0
  const timers = new Map<number, () => void>()
  const hold = new HoldToConfirm(() => calls++, (p) => { progress = p }, () => now,
    (fn) => { const id = ++next; timers.set(id, fn); return id as unknown as ReturnType<typeof setTimeout> },
    (id) => { timers.delete(id as unknown as number) })
  return { hold, calls: () => calls, progress: () => progress,
    tick(time: number) { now = time; const list = [...timers.values()]; timers.clear(); list.forEach((fn) => fn()) } }
}
test('a short tap sends no emergency', () => {
  const r = rig(); r.hold.begin(); r.tick(100); r.hold.cancel(); r.tick(5000)
  assert.equal(r.calls(), 0); assert.equal(r.progress(), 0)
})
test('999 milliseconds can never confirm; 1000 completes exactly once', () => {
  const r = rig(); r.hold.begin(); r.tick(999); assert.equal(r.calls(), 0)
  assert.ok(r.progress() < 1); r.tick(1000); assert.equal(r.calls(), 1)
  r.tick(9000); assert.equal(r.calls(), 1)
})
test('releasing and pressing again requires a fresh complete hold', () => {
  const r = rig(); r.hold.begin(); r.tick(500); r.hold.cancel(); r.hold.begin()
  r.tick(1499); assert.equal(r.calls(), 0); r.tick(1500); assert.equal(r.calls(), 1)
})
test('repeated keydowns do not restart the timer', () => {
  const r = rig(); r.hold.begin(); r.tick(1000); r.hold.begin(); r.tick(1000)
  assert.equal(r.calls(), 1)
})
test('focus, visibility, pointer cancellation and unmount share cancellation', () => {
  for (const reason of ['blur', 'hidden', 'pointercancel', 'unmount']) {
    const r = rig(); r.hold.begin(); r.tick(999); r.hold.cancel(); r.tick(1100)
    assert.equal(r.calls(), 0, reason)
  }
})
test('a delayed timer still checks elapsed time before confirmation', () => {
  const r = rig(); r.hold.begin(); r.tick(1); assert.equal(r.calls(), 0)
  r.tick(2700); assert.equal(r.calls(), 1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WifiPrinterTransport } from '../lib/wifi-printer-transport'
import { parsePositionReport } from '../lib/web-serial-printer-transport'

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  sent: { type: string; id?: number; text?: string }[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { Socket.instances.push(this) }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  open() { this.readyState = 1; this.onopen?.() }
  rx(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
  close() { this.readyState = 3; this.onclose?.() }
}

async function rig(protocol = 'http:') {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { protocol, host: '192.168.0.254' } } })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket })
  Socket.instances = []
  const transport = new WifiPrinterTransport()
  const messages: any[] = []
  transport.subscribe((message) => messages.push(message))
  await transport.connect()
  const socket = Socket.instances[0]
  if (socket) { socket.open(); socket.rx({ type: 'status', protocol: 3, ready: true }) }
  return { transport, socket, messages }
}

test('WiFi requires a ready bridge and uses the local origin', async () => {
  const { transport, socket, messages } = await rig()
  assert.equal(socket.url, 'ws://192.168.0.254/ws')
  assert.deepEqual(socket.sent[0], { type: 'hello', protocol: 3 })
  assert.ok(messages.some((m) => m.kind === 'connection' && m.state === 'connected'))
  socket.rx({ type: 'status', protocol: 3, ready: false, reason: 'Mega reiniciado' })
  assert.equal(messages.filter((m) => m.kind === 'connection').at(-1).state, 'waiting-marlin')
  await transport.disconnect()
})

test('accepted and raw ok never complete a tracked command', async () => {
  const { transport, socket, messages } = await rig()
  let done = false
  const ack = transport.sendTracked('G1 X10', {}).then(() => { done = true })
  const id = socket.sent.at(-1)!.id
  socket.rx({ type: 'accepted', id }); socket.rx({ type: 'written', id, line: 3, text: 'N3 G1 X10*82' })
  socket.rx({ type: 'rx', text: 'ok' })
  await Promise.resolve(); assert.equal(done, false)
  socket.rx({ type: 'ack', id }); await ack
  assert.equal(done, true)
  assert.ok(messages.some((m) => m.kind === 'queue' && m.pendingMovementCount === 0 && m.ack?.wasMovement))
  await transport.disconnect()
})

test('sendCommand resolves on receipt, but stays pending until private ACK', async () => {
  const { transport, socket } = await rig()
  const accepted = transport.sendCommand('M400', { pauseMarker: 'M400' })
  const id = socket.sent.at(-1)!.id
  socket.rx({ type: 'accepted', id }); await accepted
  assert.equal(transport.isIdle(), false)
  socket.rx({ type: 'ack', id }); assert.equal(transport.isIdle(), true)
  await transport.disconnect()
})

test('drop interrupts pending work and never replays it on reconnect', async () => {
  const { transport, socket } = await rig()
  const command = transport.sendTracked('G1 X10')
  const rejected = assert.rejects(command, /WiFi perdida/)
  socket.rx({ type: 'accepted', id: socket.sent.at(-1)!.id })
  socket.close(); await rejected
  await transport.requestAndConnect()
  const next = Socket.instances.at(-1)!
  next.open(); next.rx({ type: 'status', protocol: 3, ready: true })
  assert.equal(next.sent.filter((m) => m.type === 'command').length, 0)
  await transport.disconnect()
})

test('M112 bypasses accepted but unacknowledged motion', async () => {
  const { transport, socket } = await rig()
  const movement = transport.sendTracked('G1 X10')
  const rejected = assert.rejects(movement, /Parada solicitada/)
  socket.rx({ type: 'accepted', id: socket.sent.at(-1)!.id })
  const stop = transport.sendCommand('M112')
  assert.equal(socket.sent.at(-1)!.text, 'M112')
  socket.rx({ type: 'accepted', id: socket.sent.at(-1)!.id })
  await stop; await rejected; await transport.disconnect()
})

test('invalid and overlong commands never reach WiFi', async () => {
  const { transport, socket } = await rig()
  await assert.rejects(transport.sendCommand('G1 X1\nG1 X2'))
  await assert.rejects(transport.sendCommand('M117 ' + 'a'.repeat(74)))
  await assert.rejects(transport.sendCommand('N1 G1 X1*1'))
  assert.equal(socket.sent.filter((m) => m.type === 'command').length, 0)
  await transport.disconnect()
})

test('HTTPS does not attempt a blocked plaintext WebSocket', async () => {
  const { transport, messages } = await rig('https:')
  assert.equal(Socket.instances.length, 0)
  assert.ok(messages.some((m) => m.entry?.content.includes('dirección HTTP')))
  await transport.disconnect()
})

test('position parsing ignores step counts and keeps real coordinates', () => {
  assert.equal(parsePositionReport('Count X:800 Y:900 Z:1000'), null)
  assert.deepEqual(parsePositionReport('X:12.3 Y:-4.5 Z:6 Count X:800 Y:900 Z:1000'), { x: 12.3, y: -4.5, z: 6 })
})

test('legacy file tags are refused without a network command', async () => {
  const { transport, socket } = await rig()
  await assert.rejects(transport.sendCommand('G1 X1', { jobTag: 'file' }), /no carga archivos/)
  assert.equal(socket.sent.filter(m => m.type === 'command').length, 0)
  await transport.disconnect()
})

test('a fault during initial connection is shown as an error, not endless connecting', async () => {
  const { transport, socket, messages } = await rig()
  socket.rx({ type: 'status', protocol: 3, ready: false, stage: 'fault', reason: 'UART error' })
  assert.equal(messages.filter((m) => m.kind === 'connection').at(-1).state, 'error')
  assert.ok(messages.some((m) => m.kind === 'bridge' && m.detail === 'UART error'))
  await transport.disconnect()
})

test('shared status exposes the global queue and real position to a late client', async () => {
  const { transport, socket, messages } = await rig()
  socket.rx({ type: 'status', protocol: 3, ready: true, clientId: 20, bootId: 1, generation: 0,
    clients: 3, movements: 4, position: 'X:12 Y:34 Z:56', sdPrinting: true, sdDone: 20, sdTotal: 100 })
  assert.ok(messages.some((m) => m.kind === 'queue' && m.pendingMovementCount === 4))
  assert.ok(messages.some((m) => m.kind === 'bridge' && m.clients === 3 && m.sdPrinting))
  assert.ok(messages.some((m) => m.kind === 'position' && m.position.x === 12))
  await transport.disconnect()
})

test('a stale ready packet cannot clear a locally requested emergency', async () => {
  const { transport, socket, messages } = await rig()
  const status = { type: 'status', protocol: 3, ready: true, bootId: 9, generation: 0, emergency: false }
  socket.rx(status)
  const stop = transport.sendCommand('M112'); const id = socket.sent.at(-1)!.id
  socket.rx({ type: 'accepted', id }); await stop
  socket.rx(status)
  assert.equal(messages.filter((m) => m.kind === 'bridge').at(-1).emergency, true)
  socket.rx({ ...status, ready: false, stage: 'fault', emergency: true })
  assert.equal(messages.filter((m) => m.kind === 'bridge').at(-1).emergency, true)
  socket.rx({ ...status, ready: false, stage: 'boot', generation: 1, emergency: true })
  socket.rx({ ...status, generation: 1 })
  assert.equal(messages.filter((m) => m.kind === 'bridge').at(-1).emergency, false)
  await transport.disconnect()
})

test('a jog batch is one network message with one receipt per command', async () => {
  const { transport, socket } = await rig()
  const sent = transport.sendBatch(['G91', 'G0 X1', 'G90', 'M114'])
  const batch = socket.sent.at(-1)! as any
  assert.equal(batch.type, 'batch'); assert.deepEqual(batch.texts, ['G91', 'G0 X1', 'G90', 'M114'])
  for (let i = 0; i < 4; i++) socket.rx({ type: 'accepted', id: batch.id + i })
  await sent
  assert.equal(socket.sent.filter((m) => m.type === 'command').length, 0)
  await transport.disconnect()
})

test('global transmissions are logged once; unrelated ACK IDs do not complete a command', async () => {
  const { transport, socket, messages } = await rig()
  let done = false
  const ack = transport.sendTracked('M119').then(() => { done = true })
  const id = socket.sent.at(-1)!.id
  socket.rx({ type: 'accepted', id }); socket.rx({ type: 'written', id, text: 'M119' })
  socket.rx({ type: 'tx', origin: 10, text: 'M119' }); socket.rx({ type: 'ack', id: id! + 99 })
  await Promise.resolve(); assert.equal(done, false)
  socket.rx({ type: 'ack', id }); await ack
  assert.equal(messages.filter((m) => m.entry?.direction === 'TX' && m.entry.content === 'M119').length, 1)
  await transport.disconnect()
})

test('camera association is independent of Marlin readiness', async () => {
  const { transport, socket, messages } = await rig()
  socket.rx({ type: 'status', protocol: 3, ready: false, stage: 'fault', cameraAssociated: true, cameraUrl: 'http://192.168.0.31/capture', phones: 5, phoneLimit: 5 })
  const message = messages.filter(m => m.kind === 'bridge').at(-1)
  assert.equal(message.cameraAssociated, true); assert.equal(message.phones, 5)
  assert.equal(message.phoneLimit, 5)
  assert.equal(messages.filter(m => m.kind === 'connection').at(-1).state, 'error')
  socket.rx({ type: 'job', owner: 10, job: { state: 'printing' } })
  assert.equal(messages.some(m => m.kind === 'remoteJob'), false)
  await transport.disconnect()
})

test('a joining client does not change firmware line numbering or send M110', async () => {
  const { transport, socket } = await rig()
  assert.equal(socket.sent.filter((m) => m.type === 'command').length, 0)
  assert.equal(socket.sent.some((m) => m.text?.startsWith('M110')), false)
  await transport.disconnect()
})

test('shared machine intents have private receipts and share the command ID sequence', async () => {
  const { transport, socket } = await rig()
  socket.rx({ type: 'status', protocol: 3, ready: true, machineControls: true })
  let completed = false
  const pause = transport.sendMachineControl('pause').then(() => { completed = true })
  assert.deepEqual(socket.sent.at(-1), { type: 'control', id: 1, action: 'pause' })
  socket.rx({ type: 'ack', id: 1 }); await Promise.resolve(); assert.equal(completed, false)
  socket.rx({ type: 'controlAccepted', id: 1 }); await pause
  assert.equal(transport.isIdle(), true)
  const ordinary = transport.sendCommand('M119')
  assert.equal(socket.sent.at(-1)!.id, 2)
  socket.rx({ type: 'accepted', id: 2 }); await ordinary
  await transport.disconnect()
})

test('a known pause can be resumed while the initial Marlin identity is blocked', async () => {
  const { transport, socket, messages } = await rig()
  socket.rx({ type: 'status', protocol: 3, ready: false, stage: 'probe', machineControls: true,
    pausePhase: 'paused', paused: true })
  assert.equal(messages.filter(m => m.kind === 'bridge').at(-1).pausePhase, 'paused')
  await assert.rejects(transport.sendMachineControl('pause'), /no está listo/)
  const resume = transport.sendMachineControl('resume')
  const id = socket.sent.at(-1)!.id
  socket.rx({ type: 'controlAccepted', id }); await resume
  await transport.disconnect()
})

test('control rejection and connection loss never replay a pause intent', async () => {
  const { transport, socket } = await rig()
  await assert.rejects(transport.sendMachineControl('pause'), /firmware a 3.0/)
  socket.rx({ type: 'status', protocol: 3, ready: true, machineControls: true })
  const pause = transport.sendMachineControl('pause')
  const rejected = assert.rejects(pause, /Cola llena/)
  socket.rx({ type: 'controlRejected', id: socket.sent.at(-1)!.id, text: 'Cola llena' }); await rejected
  const resume = transport.sendMachineControl('resume')
  const lost = assert.rejects(resume, /WiFi perdida/); socket.close(); await lost
  await transport.requestAndConnect(); const next = Socket.instances.at(-1)!
  next.open(); next.rx({ type: 'status', protocol: 3, ready: true, machineControls: true })
  assert.equal(next.sent.filter(m => m.type === 'control').length, 0)
  await transport.disconnect()
})

test('console loss under saturation is visible and is not a fabricated command failure', async () => {
  const { transport, socket, messages } = await rig()
  const status = { type: 'status', protocol: 3, ready: true, clientId: 5, droppedConsoleLines: 3 }
  socket.rx(status); socket.rx(status)
  assert.equal(messages.filter(m => m.entry?.content.includes('líneas de consola omitidas')).length, 1)
  assert.equal(messages.filter(m => m.kind === 'connection').at(-1).state, 'connected')
  await transport.disconnect()
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CameraReceiver, CAMERA_LIMITS } from '../lib/camera-receiver'
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const jpeg = (tag = 'frame-1', body = new Uint8Array([1,2,3])) => new Response(body, { headers: { 'Content-Type': 'image/jpeg', ETag: `"${tag}"` } })
const decode = async () => ({ width: 320, height: 240, close() {} })
test('only decoded JPEGs become live; requests are direct and use CORS', async () => {
  const states: string[] = []; const frames: (Blob|null)[] = []; let args: any[] = []
  const c = new CameraReceiver('http://192.168.0.31/capture', s => states.push(s), b => frames.push(b), async (...a) => { args = a; return jpeg() }, decode)
  c.start(); await wait(40); c.stop()
  assert.ok(states.includes('live')); assert.ok(frames[0] instanceof Blob); assert.equal(args[0], 'http://192.168.0.31/capture'); assert.equal(args[1].mode, 'cors')
})
test('wrong mime, absent tag, oversized and undecodable responses never become live', async () => {
  const responses = [new Response('x'), new Response('x', { headers: { 'Content-Type': 'image/jpeg' } }), jpeg('x',new Uint8Array(CAMERA_LIMITS.bytes+1)), jpeg()]
  for (const [i,response] of responses.entries()) {
    const states: string[] = []
    const c = new CameraReceiver('http://s3/capture', s=>states.push(s), ()=>{}, async ()=>response, i===3 ? async()=>{throw Error('invalid JPEG')} : decode)
    c.start();await wait(40);c.stop();assert.equal(states.includes('live'),false);assert.ok(states.includes('offline'))
  }
})
test('a stalled response stops being current at the request deadline', async () => {
  const states: string[] = []
  const c = new CameraReceiver('http://s3/capture',s=>states.push(s),()=>{},()=>new Promise(()=>{}),decode)
  c.start();await wait(CAMERA_LIMITS.timeout+80);c.stop();assert.ok(states.includes('offline'))
})
test('an unchanged frame tag becomes stale without renewing its freshness', async () => {
  const states: string[] = []; let last: Blob|null = null
  const c = new CameraReceiver('http://s3/capture',s=>states.push(s),b=>{last=b},async()=>jpeg(),decode)
  c.start();await wait(CAMERA_LIMITS.stale+100);assert.equal(states.at(-1),'stale');assert.equal(last,null);c.stop()
})
test('a new frame recovers automatically after a camera error', async () => {
  const states: string[] = []; let count=0
  const c = new CameraReceiver('http://s3/capture',s=>states.push(s),()=>{},async()=>++count===1?new Response('off',{status:503}):jpeg('new'),decode)
  c.start();await wait(CAMERA_LIMITS.retry+100);c.stop();assert.ok(states.includes('offline'));assert.equal(states.at(-1),'live')
})
test('a temporary failed request does not remove the last good frame', async () => {
  const states: string[] = []; const frames: (Blob|null)[] = []; let count = 0
  const c = new CameraReceiver('http://s3/capture', s => states.push(s),
    b => frames.push(b),
    async () => ++count === 1 ? jpeg('ok') : new Response('unavailable', { status: 503 }), decode)
  c.start()
  await wait(CAMERA_LIMITS.interval + 100)
  assert.ok(states.includes('live'))
  assert.equal(states.at(-1), 'live')
  assert.ok(frames.at(-1) instanceof Blob)
  c.stop()
})
test('stop aborts an outstanding request and ignores a late completion', async () => {
  const states: string[] = [];let signal: AbortSignal|null=null;let finish: (r:Response)=>void=()=>{}
  const c = new CameraReceiver('http://s3/capture',s=>states.push(s),()=>{},async(_,init)=>{signal=init!.signal as AbortSignal;return new Promise(r=>{finish=r})},decode)
  c.start();await wait(10);c.stop();finish(jpeg());await wait(30)
  assert.equal((signal as AbortSignal|null)?.aborted,true);assert.equal(states.includes('live'),false)
})
test('three receivers keep at most one outstanding fetch each', async () => {
  let active=0, peak=0, calls=0
  const clients=Array.from({length:3},()=>new CameraReceiver('http://s3/capture',()=>{},()=>{},async()=>{++calls;++active;peak=Math.max(peak,active);await wait(50);--active;return jpeg(String(calls))},decode))
  clients.forEach(c=>c.start());await wait(450);clients.forEach(c=>c.stop());await wait(70)
  assert.equal(peak,3);assert.ok(calls>=6);assert.equal(active,0)
})
test('dimension limit is checked and bitmap memory is released', async () => {
  let closed=0; const states:string[]=[]
  const c=new CameraReceiver('http://s3/capture',s=>states.push(s),()=>{},async()=>jpeg(),async()=>({width:2000,height:2000,close(){++closed}}))
  c.start();await wait(40);c.stop();assert.equal(closed,1);assert.equal(states.includes('live'),false)
})

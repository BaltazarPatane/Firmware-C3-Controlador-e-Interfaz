import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MjpegParser } from '../lib/mjpeg-parser.ts'
const frame=(n)=>Uint8Array.from([0xff,0xd8,n,0xff,0xd9])
function part(image){
  const h=new TextEncoder().encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`)
  const result=new Uint8Array(h.length+image.length+2);result.set(h);result.set(image,h.length);result.set([13,10],h.length+image.length);return result
}
test('extrae primer fotograma completo',()=>{
  const x=new MjpegParser().push(part(frame(3)))
  assert.equal(x.length,1);assert.deepEqual(x[0],frame(3))
})
test('varios fotogramas concatenados',()=>{
  const a=part(frame(1)),b=part(frame(2)),all=new Uint8Array(a.length+b.length)
  all.set(a);all.set(b,a.length)
  const x=new MjpegParser().push(all)
  assert.equal(x.length,2);assert.deepEqual(x[0],frame(1));assert.deepEqual(x[1],frame(2))
})
test('el limite se aplica a cada JPEG grande aunque lleguen varios en un read',()=>{
  const large = new Uint8Array(300 * 1024).fill(42)
  large.set([0xff,0xd8]); large.set([0xff,0xd9],large.length-2)
  const a=part(large), all=new Uint8Array(a.length*3)
  for(let i=0;i<3;i++) all.set(a,i*a.length)
  const parsed=new MjpegParser().push(all)
  assert.equal(parsed.length,3)
  for(const jpeg of parsed) assert.deepEqual(jpeg,large)
})
test('fragmentos arbitrarios en cabecera y carga binaria',()=>{
  const msg=part(frame(27)),parser=new MjpegParser();const out=[]
  for(let i=0;i<msg.length;i++)out.push(...parser.push(msg.slice(i,i+1)))
  assert.equal(out.length,1);assert.deepEqual(out[0],frame(27))
})
test('rechaza Content-Length inválido',()=>{
  const parser=new MjpegParser(12)
  assert.throws(()=>parser.push(new TextEncoder().encode('--frame\r\nContent-Length: 100\r\n\r\n')))
})
test('rechaza JPEG truncado/corrupto',()=>{
  const data=part(frame(1));data[data.length-3]=0x12
  assert.throws(()=>new MjpegParser().push(data))
})
test('rechaza cabecera demasiado larga',()=>{
  assert.throws(()=>new MjpegParser().push(new Uint8Array(1100).fill(1)))
})

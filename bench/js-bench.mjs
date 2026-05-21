// Host JS benchmark: protobuf.js vs JSON over the shared payload profiles.
// Pure-JS reflection codec (protobuf.js 8) and JSON.stringify/parse, timed with
// process.hrtime.bigint(). Reports ns/op + ops/sec + p50/p95/p99 + byte size.
//
// Usage: node bench/js-bench.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import protobuf from 'protobufjs'
import { PROFILES, PROFILE_ORDER } from './payloads.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const root = protobuf.loadSync(path.join(repoRoot, 'example', 'proto', 'example.proto'))
const User = root.lookupType('acme.User')
const Long = protobuf.util.Long
if (!Long) throw new Error('protobuf.js long support unavailable')

// protobuf.js wants Uint8Array for `bytes` and a Long for 64-bit fields
// (it rejects decimal strings; a JS number would lose precision >2^53).
function toPb(profile) {
  const o = { ...profile }
  if (Array.isArray(o.avatar)) o.avatar = Uint8Array.from(o.avatar)
  if (typeof o.delta === 'string') o.delta = Long.fromString(o.delta, false) // int64
  if (typeof o.big === 'string') o.big = Long.fromString(o.big, true) // uint64
  return o
}

const WARMUP = 10000
const TRIALS = 7
const BATCH = 200000
const SAMPLES = 50000

function measure(op) {
  for (let i = 0; i < WARMUP; i++) op()

  const trials = []
  for (let t = 0; t < TRIALS; t++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < BATCH; i++) op()
    const t1 = process.hrtime.bigint()
    trials.push(Number(t1 - t0) / BATCH)
  }
  trials.sort((a, b) => a - b)
  const nsop = trials[trials.length >> 1]

  const s = new Float64Array(SAMPLES)
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = process.hrtime.bigint()
    op()
    const t1 = process.hrtime.bigint()
    s[i] = Number(t1 - t0)
  }
  s.sort()
  const pct = (p) => s[Math.floor(p * (s.length - 1))]
  return { nsop, opsps: 1e9 / nsop, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), min: s[0] }
}

let sink = 0
const results = []
for (const name of PROFILE_ORDER) {
  const profile = PROFILES[name]
  const pbObj = toPb(profile)
  const err = User.verify(pbObj)
  if (err) throw new Error(`profile ${name} invalid for protobuf.js: ${err}`)

  const msg = User.create(pbObj)
  const pbBuf = User.encode(msg).finish()
  const jsonStr = JSON.stringify(profile)

  const pbEnc = measure(() => { sink ^= User.encode(User.create(pbObj)).finish().length })
  const pbDec = measure(() => { sink ^= User.decode(pbBuf).id })
  const jsonEnc = measure(() => { sink ^= JSON.stringify(profile).length })
  const jsonDec = measure(() => { sink ^= JSON.parse(jsonStr).id })

  results.push({
    profile: name,
    pbBytes: pbBuf.length,
    jsonBytes: Buffer.byteLength(jsonStr, 'utf8'),
    protobufjs: { encode: pbEnc, decode: pbDec },
    json: { encode: jsonEnc, decode: jsonDec },
  })
}

fs.writeFileSync(path.join(__dirname, 'results-js.json'), JSON.stringify(results, null, 2))

const padL = (s, n) => String(s).padStart(n)
const pad = (s, n) => String(s).padEnd(n)
console.error('protobuf.js vs JSON (node, host CPU)\n')
console.error('profile     pbB  jsonB   pbEnc ns   pbDec ns   jsEnc ns   jsDec ns   pb/json size')
for (const r of results) {
  console.error(
    `${pad(r.profile, 10)} ${padL(r.pbBytes, 4)} ${padL(r.jsonBytes, 6)} ${padL(r.protobufjs.encode.nsop.toFixed(0), 10)} ${padL(r.protobufjs.decode.nsop.toFixed(0), 10)} ${padL(r.json.encode.nsop.toFixed(0), 10)} ${padL(r.json.decode.nsop.toFixed(0), 10)}   ${(r.pbBytes / r.jsonBytes).toFixed(2)}x`
  )
}
console.error(`\nSaved ${path.join(__dirname, 'results-js.json')}`)
void sink

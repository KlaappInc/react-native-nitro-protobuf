// Host JS benchmark: protobuf.js vs JSON over the shared payload profiles.
// Pure-JS reflection codec (protobuf.js 8) and JSON.stringify/parse, timed with
// process.hrtime.bigint(). Reports ns/op + ops/sec + p50/p95/p99 + byte size.
//
// Usage: node bench/js-bench.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import protobuf from 'protobufjs'
import {
  PROFILES,
  PROFILE_ORDER,
  BLOB_PROFILES,
  BLOB_ORDER,
  BASE64_SIZES,
} from './payloads.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const root = protobuf.loadSync(
  path.join(repoRoot, 'example', 'proto', 'example.proto')
)
const User = root.lookupType('acme.User')
const blobRoot = protobuf.loadSync(path.join(__dirname, 'proto', 'blob.proto'))
const Blob = blobRoot.lookupType('acme.Blob')
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

function toBlobPb(profile) {
  return { ...profile, data: Uint8Array.from(profile.data) }
}

const WARMUP = 10000
const TRIALS = 7
const BATCH = 200000
const SAMPLES = 50000

// Large payloads need fewer iterations to keep wall-time bounded. Scale the
// batch/sample counts down with the message size (bounded total bytes touched).
function countsFor(bytes) {
  const batch = Math.max(
    2000,
    Math.min(BATCH, Math.floor(2e8 / Math.max(1, bytes)))
  )
  const samples = Math.max(
    1000,
    Math.min(SAMPLES, Math.floor(5e7 / Math.max(1, bytes)))
  )
  const warmup = Math.min(WARMUP, batch)
  return { batch, samples, warmup }
}

function measure(
  op,
  counts = { batch: BATCH, samples: SAMPLES, warmup: WARMUP }
) {
  const { batch, samples, warmup } = counts
  for (let i = 0; i < warmup; i++) op()

  const trials = []
  for (let t = 0; t < TRIALS; t++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < batch; i++) op()
    const t1 = process.hrtime.bigint()
    trials.push(Number(t1 - t0) / batch)
  }
  trials.sort((a, b) => a - b)
  const nsop = trials[trials.length >> 1]

  const s = new Float64Array(samples)
  for (let i = 0; i < samples; i++) {
    const t0 = process.hrtime.bigint()
    op()
    const t1 = process.hrtime.bigint()
    s[i] = Number(t1 - t0)
  }
  s.sort()
  const pct = (p) => s[Math.floor(p * (s.length - 1))]
  return {
    nsop,
    opsps: 1e9 / nsop,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    min: s[0],
  }
}

// Time-budgeted measure for ops whose cost varies wildly with size (the base64
// / number[] conversions): run for ~budgetMs and derive ns/op, so a 1.9ms op
// and a 4µs op both stay bounded.
function measureTimed(op, budgetMs = 60) {
  for (let i = 0; i < 50; i++) op()
  const budget = BigInt(budgetMs) * 1000000n
  const t0 = process.hrtime.bigint()
  let count = 0
  let elapsed = 0n
  do {
    op()
    count++
    if ((count & 15) === 0) elapsed = process.hrtime.bigint() - t0
  } while (elapsed < budget)
  elapsed = process.hrtime.bigint() - t0
  const nsop = Number(elapsed) / count
  return { nsop, opsps: 1e9 / nsop }
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

  const pbEnc = measure(() => {
    sink ^= User.encode(User.create(pbObj)).finish().length
  })
  const pbDec = measure(() => {
    sink ^= User.decode(pbBuf).id
  })
  const jsonEnc = measure(() => {
    sink ^= JSON.stringify(profile).length
  })
  const jsonDec = measure(() => {
    sink ^= JSON.parse(jsonStr).id
  })

  results.push({
    profile: name,
    pbBytes: pbBuf.length,
    jsonBytes: Buffer.byteLength(jsonStr, 'utf8'),
    protobufjs: { encode: pbEnc, decode: pbDec },
    json: { encode: jsonEnc, decode: jsonDec },
  })
}

// Size sweep: representative ~1KB / ~10KB / ~50KB messages (acme.Blob).
for (const name of BLOB_ORDER) {
  const profile = BLOB_PROFILES[name]
  const pbObj = toBlobPb(profile)
  const err = Blob.verify(pbObj)
  if (err) throw new Error(`blob ${name} invalid for protobuf.js: ${err}`)

  const pbBuf = Blob.encode(Blob.create(pbObj)).finish()
  const jsonStr = JSON.stringify(profile)
  const counts = countsFor(pbBuf.length)

  const pbEnc = measure(() => {
    sink ^= Blob.encode(Blob.create(pbObj)).finish().length
  }, counts)
  const pbDec = measure(() => {
    sink ^= Blob.decode(pbBuf).text.length
  }, counts)
  const jsonEnc = measure(() => {
    sink ^= JSON.stringify(profile).length
  }, counts)
  const jsonDec = measure(() => {
    sink ^= JSON.parse(jsonStr).text.length
  }, counts)

  results.push({
    profile: name,
    pbBytes: pbBuf.length,
    jsonBytes: Buffer.byteLength(jsonStr, 'utf8'),
    protobufjs: { encode: pbEnc, decode: pbDec },
    json: { encode: jsonEnc, decode: jsonDec },
  })
}

// Base64 / number[] conversion cost: the hidden tax a user pays at the JS
// boundary, since the codec maps `bytes` to a base64 string or number[] (not a
// Uint8Array). Buffer is Node-only; React Native needs a base64 polyfill, so
// these are a lower bound for the base64 paths. The number[] paths are
// runtime-agnostic and most relevant to this codec's default output.
const base64Results = []
for (const size of BASE64_SIZES) {
  const u8 = Uint8Array.from({ length: size }, (_, i) => i % 256)
  const arr = Array.from(u8)
  const b64 = Buffer.from(u8).toString('base64')

  base64Results.push({
    bytes: size,
    b64Length: b64.length,
    u8ToBase64: measureTimed(() => {
      sink ^= Buffer.from(u8).toString('base64').length
    }),
    base64ToU8: measureTimed(() => {
      sink ^= Buffer.from(b64, 'base64').length
    }),
    u8ToNumberArray: measureTimed(() => {
      sink ^= Array.from(u8).length
    }),
    numberArrayToU8: measureTimed(() => {
      sink ^= Uint8Array.from(arr).length
    }),
  })
}

fs.writeFileSync(
  path.join(__dirname, 'results-js.json'),
  JSON.stringify(results, null, 2)
)
fs.writeFileSync(
  path.join(__dirname, 'results-base64.json'),
  JSON.stringify(base64Results, null, 2)
)

const padL = (s, n) => String(s).padStart(n)
const pad = (s, n) => String(s).padEnd(n)
console.error('protobuf.js vs JSON (node, host CPU)\n')
console.error(
  'profile     pbB  jsonB   pbEnc ns   pbDec ns   jsEnc ns   jsDec ns   pb/json size'
)
for (const r of results) {
  console.error(
    `${pad(r.profile, 10)} ${padL(r.pbBytes, 6)} ${padL(r.jsonBytes, 6)} ${padL(r.protobufjs.encode.nsop.toFixed(0), 10)} ${padL(r.protobufjs.decode.nsop.toFixed(0), 10)} ${padL(r.json.encode.nsop.toFixed(0), 10)} ${padL(r.json.decode.nsop.toFixed(0), 10)}   ${(r.pbBytes / r.jsonBytes).toFixed(2)}x`
  )
}

console.error('\nbase64 / number[] conversion cost (node, host CPU)\n')
console.error('bytes    u8->b64 ns   b64->u8 ns   u8->num[] ns   num[]->u8 ns')
for (const r of base64Results) {
  console.error(
    `${padL(r.bytes, 6)} ${padL(r.u8ToBase64.nsop.toFixed(0), 12)} ${padL(r.base64ToU8.nsop.toFixed(0), 12)} ${padL(r.u8ToNumberArray.nsop.toFixed(0), 14)} ${padL(r.numberArrayToU8.nsop.toFixed(0), 14)}`
  )
}

console.error(
  `\nSaved ${path.join(__dirname, 'results-js.json')} and results-base64.json`
)
void sink

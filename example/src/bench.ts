// On-device benchmark: NitroProtobuf (C++/JSI) vs protobuf.js (pure JS/Hermes)
// vs JSON, over the shared payload profiles (mirrors bench/payloads.mjs).
//
// Uses a time-budget loop (count ops in a fixed wall-clock window, repeat,
// take the median ops/sec) so it is robust to Hermes' coarse performance.now()
// resolution and adapts to each codec's speed. Results are logged as a single
// JSON line prefixed with BENCH_RESULT: (read via `agent-device logs` / Metro
// / logcat) and returned for on-screen display.
import protobuf from 'protobufjs'
import { NitroProtobuf } from 'react-native-nitro-protobuf'

const MESSAGE = 'acme.User'

// Mirror of bench/payloads.mjs.
const rep = (n: number, c = 'x') => c.repeat(n)
const range = (n: number, s = 0) => Array.from({ length: n }, (_, i) => s + i)

export const PROFILES: Record<string, any> = {
  tiny: { id: 7 },
  scalars: { id: 7, active: true, delta: '9007199254740993', big: '9007199254740993', ratio: 0.25, weight: 82.125 },
  string: { id: 7, name: rep(32), tags: [rep(16, 'a'), rep(16, 'b'), rep(16, 'c'), rep(16, 'd')] },
  bytes: { id: 7, avatar: range(32) },
  repeated: { id: 7, scores: [10, 20, 30, 40, 50, 60, 70, 80], tags: ['a', 'b', 'c', 'd'] },
  nested: { id: 7, address: { street: 'Main St', zip: 12345 } },
  default: {
    id: 7, name: 'Ada', active: true, delta: '9007199254740993', big: '9007199254740993',
    ratio: 0.25, weight: 82.125, scores: [10, 20], tags: ['a', 'b'], avatar: [1, 2, 3],
    address: { street: 'Main St', zip: 12345 },
  },
  large: {
    id: 4294967295, name: rep(32), active: true, delta: '9223372036854775807', big: '18446744073709551615',
    ratio: 3.4028235e38, weight: 1.7976931348623157e308, scores: range(8, 1),
    tags: [rep(16, 'a'), rep(16, 'b'), rep(16, 'c'), rep(16, 'd')], avatar: range(32),
    address: { street: rep(64, 's'), zip: 4294967295 },
  },
}
const ORDER = ['tiny', 'scalars', 'string', 'bytes', 'repeated', 'nested', 'default', 'large']

// protobuf.js type (runtime-parsed; identical schema to example.proto).
const PROTO = `
syntax = "proto3";
package acme;
message Address { string street = 1; uint32 zip = 2; }
message User {
  uint32 id = 1; string name = 2; bytes avatar = 3; repeated int32 scores = 4;
  bool active = 5; Address address = 6; repeated string tags = 7;
  int64 delta = 8; uint64 big = 9; float ratio = 10; double weight = 11;
}`
const User = protobuf.parse(PROTO).root.lookupType('acme.User')
const Long = protobuf.util.Long

function toPb(profile: any) {
  const o = { ...profile }
  if (Array.isArray(o.avatar)) o.avatar = Uint8Array.from(o.avatar)
  if (typeof o.delta === 'string' && Long) o.delta = Long.fromString(o.delta, false)
  if (typeof o.big === 'string' && Long) o.big = Long.fromString(o.big, true)
  return o
}

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

// Median ops/sec over `reps` fixed-time windows; min/max for spread.
function opsPerSec(op: () => void, budgetMs = 150, reps = 5) {
  for (let i = 0; i < 500; i++) op() // warmup
  const samples: number[] = []
  for (let r = 0; r < reps; r++) {
    let count = 0
    const start = now()
    let t = start
    do {
      op(); op(); op(); op(); op(); op(); op(); op()
      count += 8
      t = now()
    } while (t - start < budgetMs)
    samples.push(count / ((t - start) / 1000))
  }
  samples.sort((a, b) => a - b)
  return {
    opsps: samples[samples.length >> 1],
    min: samples[0],
    max: samples[samples.length - 1],
    nsop: 1e9 / samples[samples.length >> 1],
  }
}

export type BenchResults = {
  platform: string
  profiles: Array<{
    profile: string
    pbBytes: number
    jsonBytes: number
    nitro: { encode: any; decode: any }
    protobufjs: { encode: any; decode: any }
    json: { encode: any; decode: any }
  }>
}

export function runBench(platform: string): BenchResults {
  const out: BenchResults = { platform, profiles: [] }
  let sink = 0
  for (const name of ORDER) {
    const profile = PROFILES[name]
    const pbObj = toPb(profile)
    const jsonStr = JSON.stringify(profile)

    // Pre-encoded buffers for decode benches.
    const nitroBuf = NitroProtobuf.encode(MESSAGE, profile)
    const pbBuf = User.encode(User.create(pbObj)).finish()

    const row = {
      profile: name,
      pbBytes: nitroBuf.byteLength,
      jsonBytes: jsonStr.length,
      nitro: {
        encode: opsPerSec(() => { sink ^= NitroProtobuf.encode(MESSAGE, profile).byteLength }),
        decode: opsPerSec(() => { sink ^= (NitroProtobuf.decode(MESSAGE, nitroBuf) as any).id }),
      },
      protobufjs: {
        encode: opsPerSec(() => { sink ^= User.encode(User.create(pbObj)).finish().length }),
        decode: opsPerSec(() => { sink ^= (User.decode(pbBuf) as any).id }),
      },
      json: {
        encode: opsPerSec(() => { sink ^= JSON.stringify(profile).length }),
        decode: opsPerSec(() => { sink ^= JSON.parse(jsonStr).id }),
      },
    }
    out.profiles.push(row)
  }
  // eslint-disable-next-line no-console
  console.log('BENCH_RESULT:' + JSON.stringify(out))
  if (sink === 0.123) console.log('') // keep sink alive
  return out
}

// Compact, fully on-screen table (ops/sec in millions) - readable via
// `agent-device snapshot --json` since Hermes Release console.log is not
// surfaced to the host. n=NitroProtobuf p=protobuf.js j=JSON.
export function formatResults(r: BenchResults): string {
  const m = (o: any) => (o.opsps / 1e6).toFixed(3)
  const lines = [
    `[${r.platform}] ops/sec (M); E=encode D=decode; n=nitro p=pbjs j=json`,
    'profile    pbB/jsB  E:n/p/j               D:n/p/j',
  ]
  for (const p of r.profiles) {
    lines.push(
      `${p.profile.padEnd(9)} ${String(p.pbBytes).padStart(3)}/${String(p.jsonBytes).padStart(3)}  ` +
        `${m(p.nitro.encode)}/${m(p.protobufjs.encode)}/${m(p.json.encode)}   ` +
        `${m(p.nitro.decode)}/${m(p.protobufjs.decode)}/${m(p.json.decode)}`
    )
  }
  return lines.join('\n')
}

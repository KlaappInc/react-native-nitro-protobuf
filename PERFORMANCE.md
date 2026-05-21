# Performance

Precise benchmarks of `react-native-nitro-protobuf` (nanopb C++ codec behind a
Nitro HybridObject) against **protobuf.js** and **JSON**, measured at three
layers: the raw C++ codec on the host, protobuf.js/JSON on node, and the real
on-device cost under Hermes on iOS + Android.

All scripts are reproducible - see [Reproducing](#reproducing).

## TL;DR

- **Raw codec (native C++, `-O2`)**: ~0.4-2.1M encode ops/s, ~0.3-1.0M decode
  ops/s on an M1 Pro. Decode is the heavier side - it builds an `AnyMap`
  (12-40 heap allocations vs 4-13 for encode).
- **vs protobuf.js, on-device (Hermes)**: NitroProtobuf **encodes ~2-7× faster**
  and **decodes ~2× faster** for medium/large payloads. protobuf.js decodes
  *tiny* payloads faster (the JSI round-trip outweighs the codec for a handful
  of bytes).
- **vs JSON, on-device (Hermes)**: Hermes' native `JSON.stringify/parse` is
  **faster than both** protobuf codecs in raw CPU. Protobuf's win is **wire
  size** - payloads are typically **~3× smaller** than JSON. Choose protobuf
  when bandwidth/storage matters; JSON is fine (and faster) when it does not.
- **The codec's cost is marshalling, not the wire format.** On host V8,
  protobuf.js actually beats the native C++ codec - because the codec spends its
  time on `AnyMap`/`std::variant` traversal, 64-bit string parsing and
  allocation, not on protobuf encoding. Under Hermes (no JIT) the C++ codec
  wins because that heavy work runs in C++ instead of interpreted JS.
- **JSI boundary ≈ 3-5 µs/call.** Native encode of the default payload is ~2.0 µs;
  the same call from JS is ~7.0 µs. For tiny, high-frequency messages the JSI
  crossing dominates - batch where you can.
- **The codec was then optimized** (see below): decode is now **34-43 % faster**
  natively and **~40 % faster on device**, with ~30 % fewer allocations. A
  JSON-string-boundary experiment to skip `AnyMap` was measured and **rejected**
  (no consistent win).

## Optimizations applied

Targeted, behavior-preserving changes to the decode/encode hot paths
(`cpp/ProtobufCodec.cpp`): hoist the nanopb field iterator out of the per-field
decode loops (was re-`begin`-ing per field); build the result map by moving
arrays/objects/nested maps in via `AnyMap::getMap()` instead of copying through
`setAny`; reserve nested maps; O(1) field lookup (descriptor-keyed cache) instead
of linear; drop a redundant `memset`.

**Native C++ (`-O2`, M1 Pro) - before → after:**

| profile | decode ns/op | Δ | encode ns/op | Δ | dec allocs |
|---------|------:|----:|------:|----:|:--:|
| tiny     |  990 → 643 | -35 % | 465 → 364 | -22 % | 12 → 12 |
| scalars  | 1206 → 800 | -34 % |1036 → 722 | -30 % | 12 → 12 |
| string   |1464 → 914 | -38 % | 955 → 751 | -21 % | 18 → 15 |
| bytes    |1242 → 801 | -36 % | 624 → 485 | -22 % | 14 → 13 |
| repeated |1767 →1063 | -40 % |1071 → 812 | -24 % | 20 → 16 |
| nested   |1650 → 960 | -42 % |1278 → 745 | -42 % | 24 → 18 |
| default  |2434 →1593 | -35 % |2005 →1420 | -29 % | 32 → 22 |
| large    |3224 →1838 | -43 % |2558 →1908 | -25 % | 40 → 25 |

**On-device (Release, Hermes), default payload - before → after ops/sec:**

| | iOS encode | iOS decode | Android encode | Android decode |
|--|------:|------:|------:|------:|
| before | 0.143 M | 0.181 M | 0.124 M | 0.157 M |
| after  | 0.183 M | 0.256 M | 0.124 M | 0.200 M |
| Δ | +28 % | **+41 %** | ~flat | +27 % |

All 6 tests stay green, including the ASan/UBSan fuzz harness (no memory-safety
regression) and the native round-trip. Encoded sizes are unchanged.

### Rejected experiment - AnyMap-bypass via a JSON string boundary

Hypothesis: since Hermes' `JSON` is fast and passing one string across JSI is
cheap, a `decodeToJson` / `encodeFromJson` pair (C++ emits/consumes JSON text,
JS does `JSON.parse`/`stringify`) might beat Nitro's `AnyMap` marshalling. We
implemented it, verified round-trip parity, and A/B-measured it on device:

| | iOS enc n/N | iOS dec n/N | Android enc n/N | Android dec n/N |
|--|--:|--:|--:|--:|
| default | 0.183 / 0.165 | 0.256 / 0.270 | 0.124 / 0.153 | 0.200 / 0.266 |
| large   | 0.126 / 0.081 | 0.209 / 0.130 | 0.071 / 0.063 | 0.127 / 0.121 |

(n = AnyMap path, N = JSON bypass; ops/sec M.) The result is **mixed**: the
bypass wins some medium-payload cases on Android (default decode +33 %) but
**loses for large payloads on both platforms and for encode on iOS**, and the
C++ JSON write/parse is itself CPU-heavy (the `%.17g` float formatting and string
building cost more than building `AnyMap`). No consistent win → **not adopted**;
the optimized `AnyMap` path is effectively the floor for this Nitro design. The
remaining ceiling is the JSI/`AnyMap` boundary itself; the larger follow-up would
be per-message typed-struct codegen (a protobuf.js-style generated C++ codec).

## Environment

| | |
|---|---|
| CPU | Apple M1 Pro (6 performance + 2 efficiency cores) |
| OS | macOS 26.4.1 |
| Native compiler | Apple clang 21.0.0, `-std=c++20 -O2 -DNDEBUG`, no sanitizers |
| node | v24.15.0 (V8) |
| React Native | 0.85.3, Hermes V1, **Release** builds |
| react-native-nitro-modules | 0.35.7 |
| protobuf.js | 8.4.0 |
| nanopb runtime | 0.4.9.1 · protoc 34.1 |
| iOS | iPhone 17 Pro simulator |
| Android | android-35 arm64 emulator (runs natively on the M1 host) |

## Methodology

- **Message**: `acme.User` (`example/proto/example.proto`) - covers scalars,
  string, bytes, repeated and nested fields.
- **8 payload profiles** (`bench/payloads.mjs`), shared across every bench:
  `tiny` (id only), `scalars`, `string`, `bytes`, `repeated`, `nested`,
  `default` (the example, ~70 B), `large` (every field at its max).
- 64-bit fields are decimal **strings** (how the lib maps int64/uint64;
  protobuf.js gets `Long`s). bytes is a `number[]` (→ `Uint8Array` for
  protobuf.js).
- **Native / node**: warmup, then median over **7 trials** of a 200k-op batch's
  mean ns/op (throughput), plus p50/p95/p99 from a 50k individually-timed
  sample; `std::chrono::steady_clock` / `process.hrtime.bigint()`.
- **On-device**: Hermes `performance.now()` is coarse, so each cell is the
  **median over 5 fixed 150 ms windows** of ops counted (ops/sec); robust to
  clock resolution and self-adapting to each codec's speed.
- Wire sizes verified identical between the native (nanopb) and protobuf.js
  encoders for every profile.

## 1 · Raw codec - native C++ (`-O2`, M1 Pro)

No JSI, no JS runtime: the encode/decode functions called directly. ns/op is the
median-of-trials throughput; allocs is heap allocations per op.

| profile | bytes | encode ns/op | encode ops/s | enc p99 | decode ns/op | decode ops/s | dec p99 | allocs e/d |
|---------|------:|------:|------:|----:|------:|------:|----:|:--:|
| tiny     |   2 |  465 | 2.15M |  500 |  991 | 1.01M | 1084 | 4/12 |
| scalars  |  36 | 1036 | 0.97M | 1084 | 1206 | 0.83M | 1291 | 4/12 |
| string   | 108 |  955 | 1.05M | 1083 | 1464 | 0.68M | 1542 | 6/18 |
| bytes    |  36 |  624 | 1.60M |  708 | 1242 | 0.81M | 1333 | 5/14 |
| repeated |  24 | 1071 | 0.93M | 1208 | 1767 | 0.57M | 1958 | 6/20 |
| nested   |  16 | 1278 | 0.78M | 2125 | 1650 | 0.61M | 1667 | 7/24 |
| default  |  70 | 2005 | 0.50M | 2041 | 2434 | 0.41M | 2458 | 10/32 |
| large    | 267 | 2558 | 0.39M | 2708 | 3224 | 0.31M | 3208 | 13/40 |

Decode is consistently slower and allocates 2-3× more than encode: it
constructs an `AnyMap` (`std::unordered_map` + `std::variant`, nested objects
and arrays), whereas encode walks an existing map straight into a flat buffer.

## 2 · protobuf.js vs JSON - node / V8 (host)

ns/op (median-of-trials). Sizes match the nanopb encoder exactly.

| profile | pbB | jsonB | pb enc | pb dec | json enc | json dec | pb/json size |
|---------|----:|------:|------:|------:|------:|------:|:--:|
| tiny     |   2 |   8 |  128 |  42 |  83 | 147 | 0.25× |
| scalars  |  36 | 103 |  579 | 182 | 386 | 404 | 0.35× |
| string   | 108 | 135 |  906 | 429 | 298 | 405 | 0.80× |
| bytes    |  36 | 105 |  274 |  88 | 280 | 607 | 0.34× |
| repeated |  24 |  68 |  669 | 414 | 279 | 434 | 0.35× |
| nested   |  16 |  51 |  503 | 144 | 206 | 414 | 0.31× |
| default  |  70 | 210 | 1480 | 621 | 723 | 997 | 0.33× |
| large    | 267 | 501 | 2408 | 834 | 1270 | 1635 | 0.53× |

On V8, protobuf.js (JIT-compiled, plain-object codec) **outruns the native C++
codec** for this workload - confirming the codec is bottlenecked on AnyMap
marshalling, not protobuf encoding. JSON is fastest for most encodes; protobuf
is ~**3× smaller** on the wire.

## 3 · On-device (Hermes, Release) - NitroProtobuf vs protobuf.js vs JSON

ops/sec in **millions**. `n`=NitroProtobuf (C++/JSI), `p`=protobuf.js (JS),
`j`=JSON. Higher is better.

### iOS - iPhone 17 Pro simulator

| profile | pbB/jsB | enc n | enc p | enc j | dec n | dec p | dec j |
|---------|:------:|----:|----:|----:|----:|----:|----:|
| tiny     |   2/8  | 0.687 | 0.355 | 3.171 | 0.362 | 1.317 | 4.788 |
| scalars  | 36/103 | 0.315 | 0.114 | 0.671 | 0.329 | 0.203 | 1.090 |
| string   |108/135 | 0.309 | 0.045 | 0.722 | 0.261 | 0.162 | 0.980 |
| bytes    | 36/105 | 0.295 | 0.248 | 0.640 | 0.327 | 0.780 | 0.415 |
| repeated | 24/68  | 0.284 | 0.090 | 0.892 | 0.206 | 0.177 | 0.814 |
| nested   | 16/51  | 0.316 | 0.146 | 1.296 | 0.255 | 0.355 | 1.705 |
| default  | 70/210 | 0.143 | 0.051 | 0.345 | 0.181 | 0.096 | 0.437 |
| large    |267/501 | 0.097 | 0.021 | 0.140 | 0.145 | 0.057 | 0.169 |

### Android - android-35 arm64 emulator

| profile | pbB/jsB | enc n | enc p | enc j | dec n | dec p | dec j |
|---------|:------:|----:|----:|----:|----:|----:|----:|
| tiny     |   2/8  | 0.559 | 0.366 | 2.974 | 0.303 | 1.556 | 4.976 |
| scalars  | 36/103 | 0.273 | 0.130 | 0.675 | 0.290 | 0.228 | 1.169 |
| string   |108/135 | 0.268 | 0.060 | 0.753 | 0.229 | 0.183 | 1.099 |
| bytes    | 36/105 | 0.294 | 0.268 | 0.624 | 0.289 | 0.863 | 0.449 |
| repeated | 24/68  | 0.250 | 0.104 | 0.846 | 0.178 | 0.202 | 0.904 |
| nested   | 16/51  | 0.268 | 0.162 | 1.231 | 0.221 | 0.434 | 1.811 |
| default  | 70/210 | 0.124 | 0.060 | 0.352 | 0.157 | 0.109 | 0.515 |
| large    |267/501 | 0.091 | 0.028 | 0.138 | 0.129 | 0.064 | 0.189 |

iOS and Android track closely (the emulator runs arm64 + Hermes natively on the
M1 host).

## Analysis

**NitroProtobuf vs protobuf.js (the like-for-like comparison).** Under Hermes,
NitroProtobuf encodes **2-7× faster** (`default` 0.143 vs 0.051 M/s = 2.8×;
`string` 0.309 vs 0.045 = 6.9×; `large` 0.097 vs 0.021 = 4.6× on iOS). Decode is
**~2× faster** for medium/large payloads (`default` 0.181 vs 0.096; `large`
0.145 vs 0.057) but **slower for tiny/bytes** (`tiny` 0.362 vs 1.317) - when the
payload is a few bytes, the fixed JSI crossing costs more than protobuf.js's
interpreted-but-in-runtime decode. Net: NitroProtobuf is the clear win for
encode and for non-trivial decode; protobuf.js only edges it on the smallest
decodes.

**vs JSON.** Hermes ships a highly optimized native `JSON`. On pure CPU it beats
both protobuf codecs almost everywhere (`default` encode: JSON 0.345 vs nitro
0.143 vs pbjs 0.051 M/s). Protobuf's payoff is **size**: ~3× smaller on the wire
(`default` 70 B vs 210 B; `tiny` 2 B vs 8 B). Reach for protobuf when you pay for
bytes (network, persistence, IPC); stay on JSON when you do not.

**JSI overhead.** Native `default` encode is ~2.0 µs (0.50 M/s); from JS it is
~7.0 µs (0.143 M/s) - the Hermes↔C++ JSI crossing + ArrayBuffer/AnyMap
marshalling adds **~5 µs/encode** and **~3 µs/decode**. This fixed cost is why
`tiny` doesn't encode proportionally faster than `default`, and why batching
many small messages into one call beats many tiny calls.

**Where the codec spends time.** That host V8 protobuf.js beats native C++ is the
tell: the codec's hot path is `AnyMap` (`std::variant` + `unordered_map`)
construction/traversal, decimal parsing of 64-bit strings, and per-op heap
allocation (decode: 12-40 allocations), not nanopb. The biggest future win would
be reducing decode-side allocations / AnyMap churn, not the wire codec.

## Caveats

- **Release builds only.** Debug pods compile the C++ codec unoptimized, which
  would unfairly slow NitroProtobuf vs Hermes-JITed protobuf.js. All on-device
  numbers are Release.
- **Emulator, not a physical Android device.** android-35 runs arm64/Hermes
  natively on the M1, so figures are realistic but treat them as *relative*; a
  real phone (thermals, smaller cache) will differ in absolute terms.
- **Coarse on-device clock.** Hermes `performance.now()` resolution is limited;
  the 150 ms × 5-window method keeps error small but on-device cells are ±a few %.
- **Single-threaded, JS thread.** `encode`/`decode` are synchronous JSI calls on
  the JS thread (see README threading note). These numbers are steady-state,
  warm; first call is colder (JIT/cache).

## Reproducing

```bash
# 1. Native C++ microbench (needs protoc + protoc-gen-nanopb + clang++)
node bench/run-native.mjs            # -> bench/results-native.json

# 2. protobuf.js vs JSON on node
node bench/js-bench.mjs              # -> bench/results-js.json

# 3. On-device (Release): build, install, tap "Run benchmark" in the example.
#    The full ops/sec table renders on screen (read via agent-device snapshot
#    --json); see bench/results-ondevice.txt for the captured runs.
```

Profiles live in `bench/payloads.mjs`; the native bench mirrors them in
`bench/native-bench.cpp`; the on-device bench is `example/src/bench.ts`.

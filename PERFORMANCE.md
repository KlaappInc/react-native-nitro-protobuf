# Performance

Precise benchmarks of `react-native-nitro-protobuf` (nanopb C++ codec behind a
Nitro HybridObject) against **protobuf.js** and **JSON**, measured at three
layers: the raw C++ codec on the host, protobuf.js/JSON on node, and the real
on-device cost under Hermes on iOS + Android.

All scripts are reproducible - see [Reproducing](#reproducing).

## TL;DR

- **Raw codec (native C++, `-O2`)**: ~0.5-2.1M encode ops/s, ~0.5-1.3M decode
  ops/s on an M1 Pro. Decode is the heavier side - it builds an `AnyMap`
  (12-25 heap allocations vs 4-13 for encode).
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
- **JSI boundary ≈ 3-4 µs/call.** Native encode of the default payload is ~1.5 µs;
  the same call from JS is ~5.5 µs. For tiny, high-frequency messages the JSI
  crossing dominates - batch where you can.
- **The codec was then optimized** (see below): decode is now **34-43 % faster**
  natively and **~40 % faster on device**, with ~30 % fewer allocations. A
  JSON-string-boundary experiment to skip `AnyMap` was measured and **rejected**
  (no consistent win).
- **Size sweep (1-50 KB) + the `bytes` boundary tax.** Encode/decode scale ~linearly
  with size. The biggest *hidden* cost is converting a `Uint8Array` to the
  `number[]` the codec uses for `bytes` (~1.8 ms at 100 KB) - use the **base64**
  form instead (~10-50× cheaper). A single message is capped at **64 KB** by
  nanopb's default build. See [Size sweep & boundary cost](#size-sweep--boundary-cost-honest-larger-payloads).

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

Host (§1, §2, size sweep, base64) and iOS on-device numbers were re-measured in a
single quiet run with Spotlight (`mds`) indexing disabled, so the small-payload
and size-sweep tables are directly comparable.

## Methodology

- **Message**: `acme.User` (`example/proto/example.proto`) - covers scalars,
  string, bytes, repeated and nested fields.
- **8 payload profiles** (`bench/payloads.mjs`), shared across every bench:
  `tiny` (id only), `scalars`, `string`, `bytes`, `repeated`, `nested`,
  `default` (the example, ~70 B), `large` (every field at its max).
- **Size sweep**: 3 larger `acme.Blob` profiles (`bench/proto/blob.proto`) at
  ~1/10/50 KB, plus a **base64 / `number[]` conversion micro-bench** over
  256 B-100 KB buffers (the `bytes` boundary cost). The base64 bench is
  time-budgeted (~60 ms/measure) since per-op cost spans 4 µs-5 ms.
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
| tiny     |   2 |  479 | 2.09M |  583 |  788 | 1.27M |  875 | 4/12 |
| scalars  |  36 |  837 | 1.19M |  958 |  980 | 1.02M | 1125 | 4/12 |
| string   | 108 |  899 | 1.11M | 1000 | 1040 | 0.96M | 1208 | 6/15 |
| bytes    |  36 |  600 | 1.67M |  667 |  917 | 1.09M | 1041 | 5/13 |
| repeated |  24 |  904 | 1.11M | 1041 | 1174 | 0.85M | 1292 | 6/16 |
| nested   |  16 |  840 | 1.19M |  917 | 1061 | 0.94M | 1167 | 7/18 |
| default  |  70 | 1509 | 0.66M | 1667 | 1517 | 0.66M | 1667 | 10/22 |
| large    | 267 | 1974 | 0.51M | 2209 | 1893 | 0.53M | 2042 | 13/25 |

Decode is consistently slower and allocates 2-3× more than encode: it
constructs an `AnyMap` (`std::unordered_map` + `std::variant`, nested objects
and arrays), whereas encode walks an existing map straight into a flat buffer.

## 2 · protobuf.js vs JSON - node / V8 (host)

ns/op (median-of-trials). Sizes match the nanopb encoder exactly.

| profile | pbB | jsonB | pb enc | pb dec | json enc | json dec | pb/json size |
|---------|----:|------:|------:|------:|------:|------:|:--:|
| tiny     |   2 |   8 |   99 |  28 |  64 | 110 | 0.25× |
| scalars  |  36 | 103 |  429 | 135 | 289 | 303 | 0.35× |
| string   | 108 | 135 |  652 | 320 | 225 | 308 | 0.80× |
| bytes    |  36 | 105 |  205 |  64 | 211 | 438 | 0.34× |
| repeated |  24 |  68 |  491 | 282 | 202 | 327 | 0.35× |
| nested   |  16 |  51 |  373 | 110 | 153 | 297 | 0.31× |
| default  |  70 | 210 | 1077 | 454 | 542 | 728 | 0.33× |
| large    | 267 | 501 | 1754 | 614 | 935 | 1192 | 0.53× |

On V8, protobuf.js (JIT-compiled, plain-object codec) **outruns the native C++
codec** for this workload - confirming the codec is bottlenecked on AnyMap
marshalling, not protobuf encoding. JSON is fastest for most encodes; protobuf
is ~**3× smaller** on the wire.

## Size sweep & boundary cost (honest, larger payloads)

The 8 profiles above are small (≤267 B), where fixed per-call costs dominate.
This section adds **representative larger messages** (`acme.Blob`,
`bench/proto/blob.proto`: a long string, a byte array, repeated strings and
repeated nested messages) at ~1 KB / 10 KB / 50 KB, plus the **conversion cost a
real app pays at the JS boundary** for `bytes`.

> **Why 50 KB, not 100 KB?** As shipped, nanopb caps a single message at **64 KB**
> (`PB_FIELD_32BIT` off). A 100 KB message will not compile without that flag, so
> we benchmark within the limit the library actually enforces (see ROADMAP).

Same single quiet run as §1-§2, so these are directly comparable. Large payloads
run proportionally fewer iterations (bounded total work).

**Native C++ codec (`-O2`, M1 Pro):**

| profile | bytes | encode ns/op | decode ns/op | allocs e/d |
|---------|------:|------:|------:|:--:|
| blob1k  |  1 124 |   4 824 |   5 066 | 32/32 |
| blob10k | 10 124 |  12 420 |  19 068 | 32/32 |
| blob50k | 50 126 |  56 517 |  68 912 | 32/32 |

Encode/decode scale roughly linearly with size (≈1.1 ns/byte encode, ≈1.4 ns/byte
decode at 50 KB), and allocation count is flat - the per-field cost amortizes
into the bulk string/array copy.

**protobuf.js vs JSON (node / V8):**

| profile | pbB | jsonB | pb enc | pb dec | json enc | json dec | pb/json |
|---------|----:|------:|------:|------:|------:|------:|:--:|
| blob1k  |  1 126 |   2 179 |  1 419 |   776 |   2 678 |   3 746 | 0.52× |
| blob10k | 10 126 |  20 439 |  2 886 | 1 006 |  23 514 |  28 701 | 0.50× |
| blob50k | 50 128 | 101 577 |  9 361 | 1 828 | 113 531 | 161 534 | 0.49× |

At these sizes protobuf is **~2× smaller** than JSON and protobuf.js **decode
pulls clearly ahead** of JSON (1.8 µs vs 162 µs at 50 KB - JSON re-parses the
whole text, protobuf.js skips fields it can). Encode favours protobuf too.

**Boundary conversion cost (the `bytes` tax).** The codec returns `bytes` as a
base64 `string` or a `number[]` - **not** a `Uint8Array`. An app holding binary
data therefore converts at the edge. ns/op on node (Buffer-based base64; React
Native needs a base64 polyfill, so its base64 paths cost more):

| bytes | `Uint8Array`→base64 | base64→`Uint8Array` | `Uint8Array`→`number[]` | `number[]`→`Uint8Array` |
|------:|------:|------:|------:|------:|
|    256 |     165 |     136 |     3 750 |     362 |
|  1 024 |     305 |     281 |    15 189 |     794 |
| 10 240 |   2 353 |   1 901 |   145 405 |   6 881 |
|102 400 |  42 161 |  15 335 | 1 772 319 |  58 060 |

The headline: **`Uint8Array`→`number[]` is by far the most expensive path**
(~1.8 ms for 100 KB - it allocates a JS array of boxed numbers), an order of
magnitude slower than base64 and capable of dwarfing the encode/decode itself.
**For binary-heavy messages, use the base64 string form, not `number[]`.** This
boundary cost is exactly why first-class `Uint8Array`/`ArrayBuffer` support for
`bytes` is the top DX item on the [ROADMAP](./ROADMAP.md).

## 3 · On-device (Hermes, Release) - NitroProtobuf vs protobuf.js vs JSON

ops/sec in **millions**. `n`=NitroProtobuf (C++/JSI), `p`=protobuf.js (JS),
`j`=JSON. Higher is better.

### iOS - iPhone 17 Pro simulator

| profile | pbB/jsB | enc n | enc p | enc j | dec n | dec p | dec j |
|---------|:------:|----:|----:|----:|----:|----:|----:|
| tiny     |   2/8  | 0.759 | 0.456 | 3.986 | 0.453 | 1.693 | 6.138 |
| scalars  | 36/103 | 0.386 | 0.149 | 0.870 | 0.415 | 0.263 | 1.414 |
| string   |108/135 | 0.381 | 0.058 | 0.930 | 0.342 | 0.207 | 1.262 |
| bytes    | 36/105 | 0.345 | 0.321 | 0.537 | 0.415 | 0.823 | 0.537 |
| repeated | 24/68  | 0.352 | 0.117 | 1.148 | 0.270 | 0.229 | 1.049 |
| nested   | 16/51  | 0.378 | 0.190 | 1.694 | 0.341 | 0.461 | 2.226 |
| default  | 70/210 | 0.180 | 0.067 | 0.454 | 0.251 | 0.124 | 0.581 |
| large    |267/501 | 0.126 | 0.028 | 0.181 | 0.207 | 0.073 | 0.218 |

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
M1 host). The host and iOS numbers were freshly re-measured for this revision
(quiet machine, Spotlight indexing disabled); the Android column is retained from
the prior Release emulator run (not re-run this pass) and is consistent with it.

## Analysis

**NitroProtobuf vs protobuf.js (the like-for-like comparison).** Under Hermes,
NitroProtobuf encodes **2-7× faster** (`default` 0.180 vs 0.067 M/s = 2.7×;
`string` 0.381 vs 0.058 = 6.6×; `large` 0.126 vs 0.028 = 4.5× on iOS). Decode is
**~2× faster** for medium/large payloads (`default` 0.251 vs 0.124; `large`
0.207 vs 0.073) but **slower for tiny/bytes** (`tiny` 0.453 vs 1.693) - when the
payload is a few bytes, the fixed JSI crossing costs more than protobuf.js's
interpreted-but-in-runtime decode. Net: NitroProtobuf is the clear win for
encode and for non-trivial decode; protobuf.js only edges it on the smallest
decodes.

**vs JSON.** Hermes ships a highly optimized native `JSON`. On pure CPU it beats
both protobuf codecs almost everywhere (`default` encode: JSON 0.454 vs nitro
0.180 vs pbjs 0.067 M/s). Protobuf's payoff is **size**: ~3× smaller on the wire
(`default` 70 B vs 210 B; `tiny` 2 B vs 8 B). Reach for protobuf when you pay for
bytes (network, persistence, IPC); stay on JSON when you do not.

**JSI overhead.** Native `default` encode is ~1.5 µs (0.66 M/s); from JS it is
~5.5 µs (0.180 M/s) - the Hermes↔C++ JSI crossing + ArrayBuffer/AnyMap
marshalling adds **~4 µs/encode** and **~2.5 µs/decode**. This fixed cost is why
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

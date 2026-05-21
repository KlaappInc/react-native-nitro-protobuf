# `react-native-nitro-protobuf` — deep audit vs `protobuf.js`

> Audit date 2026-05-19 · commit `main` (HEAD at clone time) · auditor: Claude (caveman mode lite)
> Goal: surface design gaps + suspected crash hotspots to debug user-reported production crashes (cause unknown, no repro yet).

---

## 0b. Exhaustive fuzz + sanitizer pass (2026-05-20, host, ASan/UBSan)

Built a dedicated harness (`harness.cpp`) compiling the **real** `ProtobufCodec.cpp` + vendored nanopb + the example's generated `acme.User`/`acme.Address` sources + nitro `AnyMap`/`ArrayBuffer`/`jsi`, under `-fsanitize=address,undefined`.

**Result: 40,405 checks PASS, 0 fail, ZERO ASan/UBSan reports.**

Coverage:
- Full round-trip of every field type (uint32, string, bytes, repeated int32, bool, nested message, repeated string, int64, uint64, float, double).
- Integer boundaries: INT64_MAX, INT64_MIN, UINT64_MAX round-trip exactly.
- String/bytes/repeated boundaries: exact-capacity (`name` 32 in `char[33]`, `avatar` 32, `scores` 8, `tags` 4×16) pass; one-over throws cleanly.
- Type mismatches (string↔number↔bool↔object), unknown fields, nested wrong-type — all throw cleanly.
- **Decode fuzz (the C1/C6 crash-suspect path):** 20,000 random byte buffers, every truncation prefix of a valid message, every single-bit flip of a valid message, all 256 single-byte buffers, and crafted oversize length-delimited fields — **none crashed; all either decoded or threw a clean `std::exception`.**

**Conclusion:** the codec + nanopb decode path is **memory-safe** against adversarial wire input. Hotspots **C1** (`strnlen`) and **C6** (`offsetof` underflow) are defense-in-depth gaps but are **not reachable as crashes** via wire input — nanopb enforces field bounds before the codec reads. Still worth the cheap fixes, but they are not the production crash.

### Bugs found by the harness
1. **`AnyMap` setters silently do not overwrite an existing key.** `react-native-nitro-modules/cpp/core/AnyMap.cpp` uses `_map.emplace(key, value)` for `setString/setDouble/setBoolean/setBigInt/setArray/setObject/setAny`. `emplace` is a no-op if the key exists → only the *first* set for a key wins. **Scope:** harmless in the normal JS→C++ flow (the JSIConverter sets each unique JS property exactly once) and in decode (`setAny` once per field), so it does **not** corrupt app data today. But it is a latent correctness bug — any C++ caller that re-sets a key gets stale data. Fix: `insert_or_assign`. (Upstream dependency, not this repo.)
2. **`stod`/`stoll`/`stoull` accept a valid prefix + trailing garbage** (`"1.2.3.4"` → 1.2, `"12abc"` → 12) for numeric fields fed as strings. No crash; silent wrong value. Matches hotspot **C2** — wrap in `try/catch` AND reject trailing chars.

---

## 0. Runtime verification (2026-05-20, iOS sim, agent-device)

Built + ran the example app on an **iPhone 17 Pro simulator (iOS 26.5, Xcode 26.5)** on the Mac mini and drove it with `agent-device 0.14.8`.

### Build environment notes
- **Blocker (env, not the lib):** RN 0.83's bundled `fmt 11.0.2` fails to compile under Xcode 26.5 clang — `call to consteval function ... is not a constant expression` (pulled in via Yoga/glog). `fmt` fixed this in 11.1+. **Workaround applied:** `FMT_USE_CONSTEVAL=0` via Podfile `post_install`, plus an `#ifndef FMT_USE_CONSTEVAL` guard around the autodetect block in `Pods/fmt/include/fmt/base.h` (the header `#define`s it unconditionally, so the `-D` alone was ignored). After that the app built, installed, and launched clean. **nitro-protobuf's own C++ never failed to compile.**
- `bundler` 1.17.2 (pinned in example `Gemfile.lock`) is incompatible with ruby 4.0.2 → bypassed with global CocoaPods 1.16.2.

### Results
| Check | Outcome |
|-------|---------|
| Host native round-trip test (`bun run test`, compiles real codec + nanopb + AnyMap + jsi) | **5/5 pass** — happy path + `max_length`/`max_count`/`max_size`/unknown-field/map/oneof throw paths all correct |
| iOS baseline round-trip (`acme.User`, full sample) | **Works** — 70 B encoded, encode 0.08 ms / decode 0.04 ms, no error. JSI bridge + AnyMap marshalling + nanopb codec all functional on Hermes |
| Registry exception → JSI → Hermes (message name `acme.Nope` → `HybridProtobuf::encode` throws `std::runtime_error("Unknown message")`) | **Graceful** — JS error card `"Protobuf.encode(...): Unknown message: acme.Nope"`, **no crash** |
| **Codec encode-limit** → JSI → Hermes (valid JSON, `name`=40 chars > `max_length` 32 → `ProtobufCodec` throws `"String exceeds max_length"`) | **Graceful** — JS error card `"Protobuf.encode(...): String exceeds max_length"`, **no crash** (evidence: `encode-maxlength-error.png`). Confirms the nanopb static-buffer overflow guard propagates safely on device |
| Various malformed payloads driven through the UI | App always showed a JS error card and **never crashed** (process pid persisted across all attempts) |
| Crash-signal scan of device logs (`SIGABRT`/`SIGSEGV`/`EXC_BAD`/`libc++abi`/`terminating`) | **None** |

Evidence: `/tmp/pb/evidence/unknown-message-error.png` on the Mac mini.

### Conclusion of this phase
- **The codec's own `throw std::runtime_error(...)` paths are NOT the production crash source.** On iOS/Hermes they are caught by Nitro and re-surfaced as catchable JS exceptions; the app does not crash.
- This *eliminates* hotspots C2/C5/C6/G4-class user-error throws as crash causes (they degrade gracefully), and **re-weights the suspect list** toward:
  1. **Cross-thread / wrong-runtime JSI invocation** (worklet, non-JS thread) — **not exercisable** via this example; still the #1 hypothesis. Needs inspection of *where the user's app calls encode/decode*.
  2. **Memory bug on malformed/adversarial DECODE input** (C1 `strnlen`, C6 `offsetof` underflow) — the example only ever decodes its own valid encode output, so this path is **unexercised**. A decode-fuzz harness (feed `decodeMessage` random/truncated buffers) is the next concrete step.
  3. **User's specific RN / Nitro / Xcode version combo** differing from this clean build.

### agent-device caveats discovered (for future runs)
- `fill` on a **multiline RN `TextInput` does not clear** existing text — it inserts at the cursor, concatenating into invalid JSON. Single-line `TextField` clears fine. Driving the JSON payload field needs a real clear control (the app has none) — test encode-limit cases via the host test instead, or add a clear button.
- iOS bilingual-keyboard onboarding modal ("Type English and French" / Continue) intercepts taps and churns refs; tap a neutral area to drop the keyboard before reading result cards.

---

## 1. Architecture at a glance

```
┌─────────────────── JS (React Native) ────────────────────┐
│  NitroProtobuf.encode(name, AnyMap) -> ArrayBuffer       │
│  NitroProtobuf.decode(name, ArrayBuffer) -> AnyMap       │
│  NitroProtobuf.listMessages() -> string[]                │
└──────────────────────────┬───────────────────────────────┘
                           │ JSI (sync, JS thread)
┌──────────────────────────▼───────────────────────────────┐
│  HybridProtobuf::{encode,decode,listMessages}            │
│    → getMessageInfo(name) → ProtobufRegistry             │
│    → encodeMessage / decodeMessage (ProtobufCodec.cpp)   │
│         → walk AnyMap, pb_field_iter_*, write to         │
│           static C struct, then pb_encode / pb_decode    │
└──────────────────────────┬───────────────────────────────┘
                           │ Nanopb (vendored under cpp/nanopb)
                           ▼
                  wire-format bytes
```

`protobuf.js` for comparison: pure-JS `Reader`/`Writer` walking wire bytes against a reflection tree built from `.proto` source (or pre-codegen'd static JS).

---

## 2. Subsystem dive

### 2.1 `cpp/ProtobufCodec.cpp` (606 LoC) — encode/decode core

Two public entry points: `encodeMessage(info, AnyMap)` and `decodeMessage(info, ArrayBuffer)`. Internally:

- `populateMessage(info, struct*, AnyObject)` walks every key in the JS-supplied object, finds matching nanopb field via `pb_field_iter_find(tag)`, writes scalar via `memcpy`, recurses for sub-messages.
- `decodeMessageInternal(info, struct*)` iterates declared `FieldInfo` array, reads each field, builds `AnyMap`.
- Type marshalling done by `get*Value(AnyValue&, T&)` helpers that pattern-match the `std::variant<NullType, bool, double, int64_t, string, AnyArray, AnyObject>`.

#### Crash hotspots

| ID | Severity | Site | Issue | Fix |
|----|----------|------|-------|-----|
| **C1** | HIGH | `decodeSingleValue` String case, lines 447–450 | `std::string(reinterpret_cast<const char*>(data))` — `strlen`-based. Relies on nanopb null-terminating static strings. If wire payload was crafted to fill `max_length+1` without trailing null (nanopb does write null) **OR** memory corruption upstream, reads past buffer. No defense in depth. | `return AnyValue(std::string(str, strnlen(str, iter.data_size)));` |
| **C2** | HIGH | `getDoubleValue`/`getInt64Value`/`getUInt64Value`, lines 58, 74, 92 | `std::stod/stoll/stoull` throws `std::invalid_argument` or `std::out_of_range` on non-numeric or oversize input. Functions are supposed to return `bool` for unsupported cases — exception bypasses caller's `if (!get...)` error path. Nitro catches `std::exception` so propagates as opaque JS error, but cascades from inside repeated-array loops can leak partial writes. | Wrap each `std::sto*` in `try { … } catch (const std::exception&) { return false; }`. |
| **C3** | HIGH | `populateMessage`, lines 315 + 414 (nested message recursion) | `nestedInfo->init_default(data)` called **without** null check. Top-level `encodeMessage` line 561 **does** null-check. Inconsistent. If generator ever emits a `MessageInfo` with `init_default = nullptr` (e.g. empty message, hand-written registry, or registry/codegen drift) → SIGSEGV. | Add `if (nestedInfo->init_default != nullptr)` guard, or change `MessageInfo` invariant + assert at registry build. |
| **C4** | HIGH | `populateMessage` outer loop, line 205 | Calls `pb_field_iter_begin(&iter, info.descriptor, message)` then `pb_field_iter_find(iter, tag)` **on every input entry**. O(F × E) per message where F = field count, E = entries supplied. Not a crash by itself but compounds latency on large messages and amplifies any time-budget bug downstream. | Cache: one `pb_field_iter_begin` then `pb_field_iter_find` per entry (find walks all fields too — better: pre-index `FieldInfo*` by name). |
| **C5** | MED | `setStringValue`, line 160 | `if (value.size() >= capacity)` throws. `capacity = iter.data_size` is `max_length + 1` (nanopb adds null byte). So an input exactly `max_length` chars **passes** (good) and one of `max_length+1` chars throws (good). **But** error message says `"String exceeds max_length"` without the actual lengths — debugging blind. | Include lengths in message: `"String " + std::to_string(value.size()) + " > max_length " + std::to_string(capacity-1)`. |
| **C6** | MED | `setBytesValue`, line 183 | `size_t maxSize = iter.data_size - offsetof(pb_bytes_array_t, bytes);` — if `iter.data_size < offsetof` (corrupt registry / mismatched header), unsigned underflow → `maxSize ≈ SIZE_MAX` → buffer overflow on `memcpy`. | Guard: `if (iter.data_size < offsetof(pb_bytes_array_t, bytes)) throw …;` |
| **C7** | MED | `getBytesValue` array path, lines 126–139 | Calls `getDoubleValue(item)` which itself calls `std::stod` on string items. So `bytes: ["12", "abc"]` triggers `stod("abc")` → exception. Should reject non-number AnyArray elements directly. | Replace with `std::get_if<double>` / `std::get_if<int64_t>` only. |
| **C8** | LOW | `decodeSingleValue` Message case re-walks nested fields by re-calling `pb_field_iter_begin_const` inside loop (lines 475-477) | Same O(n²) pattern as C4 but on decode side. | Iterate `pb_field_iter_next` instead of `_find(tag)`. |
| **C9** | LOW | `encodeMessage` line 559 `std::vector<uint8_t> storage(info.struct_size)` | Heap allocation per call. For struct_size in MB range (lots of fixed buffers) → allocator pressure under burst load. | Pool / reuse via thread-local buffer. |

#### What's actually safe (audited and OK)

- `pb_encode` / `pb_decode` return values **are** checked (lines 568, 574, 598) and converted to `std::runtime_error` with the nanopb errmsg.
- `pb_size_t` count is written before payload (line 224-226), matching nanopb's contract.
- `iter.pSize` for OPTIONAL fields (proto3 `optional`) is set to `true` on write (line 322-324), respected on read (line 482).
- Submessage descriptor lookup uses **pointer** (`iter.submsg_desc`) not name → bypass of the generator's stale `type_name` field (see G2).
- ArrayBuffer returned via `ArrayBuffer::move(std::move(output))` — Nitro owns the vector, so no use-after-free if user retains the buffer.
- `ensureSupportedField` runs **on every iter visit** and throws clearly for map / oneof / non-static / callback-submsg. No silent miscompilation.

### 2.2 `cpp/Base64.cpp` (74 LoC)

Hand-rolled standard alphabet (`A-Za-z0-9+/`), no URL-safe variant. Encode pads with `=`. Decode skips `\r\n \t`, stops at first `=`, throws on any other invalid char.

| ID | Severity | Site | Issue |
|----|----------|------|-------|
| **B1** | LOW | `base64Decode` line 46 | `output.reserve((input.size()/4)*3)` slightly under-reserves when input has no padding (vector grows fine, no crash, minor perf). |
| **B2** | LOW | line 52 — only `\r\n \t` skipped | RFC 4648 also allows form-feed (`\f`). Real-world rarely matters. |
| **B3** | INFO | No URL-safe alphabet | If user ever passes URL-safe base64 (`-_`), throws "Invalid base64 character". |

**No buffer overflow / OOB**. Clean.

### 2.3 `cpp/HybridProtobuf.cpp` (29 LoC) — JSI bridge

Three method bodies, each: lookup `MessageInfo`, throw on miss, delegate to codec. **No issues.** Just plumbing.

### 2.4 `cpp/ProtobufRegistry.hpp` + `generated/nitro_protobuf_registry.cpp` (60 LoC, auto-gen)

`MessageInfo` is `{name, descriptor*, struct_size, FieldInfo[], field_count, init_default}`. Lookup is linear scan (`O(N)` messages, `O(F)` fields). Fine until thousands of messages.

| ID | Severity | Site | Issue |
|----|----------|------|-------|
| **R1** | LOW | Linear scan by name | For apps with hundreds of message types, `getMessageInfo(name)` becomes hot. Replace with `unordered_map` at process init. |
| **R2** | LOW | `FieldInfo` stores `name` as `const char*` → linear scan in `findFieldByName` | Same, build per-message name→index map once. |

### 2.5 `scripts/generate-protos.mjs` (322 LoC) — schema → C registry generator

Uses `protobufjs` to parse `.proto` schemas, walks resolved `Type` nodes, emits a C++ registry. Then shells out to `protoc` + `protoc-gen-nanopb` for the actual `.pb.c`/`.pb.h`.

| ID | Severity | Site | Issue | Fix |
|----|----------|------|-------|-----|
| **G1** | MED | `cppString`, line 67 | Regex `/\\\\/g` matches literal `\\` (two backslashes). Replace target `'\\\\\\\\'` = four. So `\\` → `\\\\`. Single `\` not escaped at all. For valid proto identifiers (no backslash possible) this is a no-op — dead defensive code. | Either delete or fix to escape single `\` too. |
| **G2** | MED | `mapFieldType` callsite for typeName, line 237 | `field.resolvedType?.fullName?.replace(/^\\./, '') ?? ''` — regex `/^\\./` is "leading backslash + any char", **not** "leading dot". Intent was `/^\./`. Effect: `type_name` literal in registry retains leading dot (`.acme.User`). However codec never reads `type_name` (uses `iter.submsg_desc` pointer instead), so latent. Will bite if anyone adds dynamic by-name submsg lookup. | `replace(/^\./, '')`. |
| **G3** | LOW | line 197 — sort by `fullName.localeCompare` | Sort is stable + alphabetical. nanopb file order may differ. Field tags are absolute so wire-format OK, but generator output not byte-stable across `.proto` reorderings. | Acceptable. |
| **G4** | MED | Generator does NOT verify `.options` file exists per `.proto` | Without `.options`, nanopb defaults string/bytes/repeated to **callback** type (dynamic, requires user-supplied encode/decode hooks). Codec then throws `"Only static nanopb fields are supported"`. **This is the most likely user-facing crash trigger** if the user added a new message but forgot the `.options` companion. | Generator should parse `.options` files and warn for any string/bytes/repeated field missing limits. |
| **G5** | LOW | No support for `enum` codegen check | Field type `Enum` becomes `int32_t` in codec, which matches nanopb. OK. |
| **G6** | LOW | Generator emits `init_default_${name}` that assigns `*static_cast<X*>(message) = X_init_default`. Works for proto3 (zero init). For proto2 with default values, nanopb's `X_init_default` carries those. Fine. |
| **G7** | INFO | Generator does NOT detect nested messages with circular refs (proto3 disallows but checked at proto compile time, not here). |

### 2.6 `src/index.ts` + `src/specs/Protobuf.nitro.ts` (10 LoC total)

Public API surface matches nitrogen-generated spec (`HybridProtobufSpec.hpp`) — no drift. `AnyMap` from `react-native-nitro-modules` is the JS-side shape, marshalled by nitro's JSIConverter (which produces nested `AnyObject` for plain JS objects, `AnyArray` for arrays, primitives directly, and refuses `Uint8Array` / `Date` / `Map` / `Set` / `Symbol` — `canConvert` returns `false`, JSI throws TypeError).

**Implication**: user passing a `Uint8Array` for a `bytes` field (the protobuf.js native shape) will **fail at the JSI boundary** before reaching C++. Must base64-encode in JS first or pass `number[]`. **Common foot-gun.**

### 2.7 `ios/**` + `android/**` glue

- iOS podspec (`NitroProtobuf.podspec`): includes `cpp/**` + `generated/**`, depends on `React-jsi` + `React-callinvoker` + `install_modules_dependencies(s)`. Looks clean.
- Android `CMakeLists.txt`: globs `cpp/*.cpp`, `generated/*.cpp`, `generated/*.pb.c`, `cpp/nanopb/*.c`. Compiles with `-frtti -fexceptions -Wall -Wextra -fstack-protector-all` (`-O1 -g` debug, `-O2` release).
- Android `fix-prefab.gradle`: hack to re-trigger prefab metadata after CMake build. Known Nitro workaround.
- Both load via nitrogen autolinking → `HybridObjectRegistry::registerHybridObjectConstructor("Protobuf", …)`.

**No obvious bugs here.** One concern: `-frtti -fexceptions` is correctly enabled so C++ exceptions can propagate up to the JSI try/catch in Nitro. Good.

### 2.8 `tests/native-roundtrip.test.mjs` + `tests/generate-protos.test.mjs`

`generate-protos.test.mjs`: generator-only tests using `--skipProtoc`. Asserts registry text matches regex patterns. **Tests show generator marks oneof + map correctly**, which means codec's `ensureSupportedField` throw paths are exercised in roundtrip test.

`native-roundtrip.test.mjs`: compiles entire stack (codec + nanopb + nitro AnyMap + jsi) on host, runs C++ binary that exercises encode/decode. Covers:
- Round-trip every supported scalar type + repeated + nested message.
- `max_length` / `max_count` / `max_size` overruns (expects throws — exercises C2 path).
- Unknown field (expects throws).
- map field + oneof field (expects throws).

**Skipped if** `protoc`, `protoc-gen-nanopb`, or `c++` compiler missing. macmini has `protoc` via brew (or can be installed), nanopb via `brew install nanopb`, and the system clang.

**Coverage gap**: no fuzz on `decodeMessage` with corrupt wire input (truncated, malformed varint, wrong field tag, deeply nested infinite loop guard, etc.). Adding this is the fastest way to flush remaining C1 / C6 issues.

---

## 3. Comparison matrix vs `protobuf.js`

| Aspect | `react-native-nitro-protobuf` | `protobuf.js` |
|--------|-------------------------------|---------------|
| **Engine** | Nanopb (C, static buffers) | Pure JS Reader/Writer |
| **Schema load** | Compile-time (`.proto` → `.pb.c` + registry C++) | Runtime reflection (parses `.proto`) **or** static codegen (`pbjs --target static-module`) |
| **Bytes JS in** | `string` (base64) or `number[]` | `Uint8Array` (preferred) or `number[]` |
| **Bytes JS out** | `string` (base64) always | `Uint8Array` |
| **Int64 JS in** | `string` only (numeric strings) | `Long` object, `string`, or `number` (with precision loss) |
| **Int64 JS out** | `string` always | `Long` object by default, `string` with `forceLong:'string'` |
| **Float32 / Float64** | `double` JS | `number` JS |
| **Enum** | `number` (int32) | `number` (or `string` with `enums:String`) |
| **proto3 `optional`** | Supported via nanopb `has_*` flag | Supported via `$type.fieldsById` |
| **proto2 required** | Supported; nanopb throws on missing | Supported |
| **proto2 default values** | Via nanopb `X_init_default` constants | Via reflection |
| **`oneof`** | **Throws** — `ensureSupportedField` | Supported (round-trip preserves which-one) |
| **`map<K, V>`** | **Throws** — `ensureSupportedField` | Supported (round-trip preserves entries) |
| **`group` (proto2)** | **Throws** — generator doesn't map | Supported |
| **Extensions (proto2)** | Not supported | Supported |
| **`Any`, `Timestamp`, `Duration`, `Struct`, `FieldMask`, well-known wrappers** | Not supported (no helpers; would round-trip as raw message) | Supported with `toJSON`/`fromObject` helpers |
| **Unknown fields on decode** | Silent skip (nanopb default; not preserved on re-encode) | Configurable |
| **Wire-format compliance** | Full (delegated to nanopb) | Full |
| **Max field size** | Per `.options` (`max_length`, `max_size`, `max_count`) — **hard cap** | None (dynamic) |
| **Required `.options` per field** | Yes for `string` / `bytes` / repeated (else nanopb generates callback type → codec throws) | N/A |
| **Threading** | Sync JSI call on JS thread (Hermes / JSC). **Calling from worklet thread → undefined behaviour** (uses HybridObject from JS runtime that may not be the same as worklet runtime) | JS-only, single-thread JS |
| **Memory** | Heap vector per call sized to `struct_size`, plus a vector for encoded output | JS heap |
| **Performance** | Native C++ encode/decode; sync JSI overhead ~tens of μs per call | Pure JS; expect 5–10× slower for large messages, but no native crash surface |
| **Error model** | `std::runtime_error` → caught by Nitro, surfaces as JS `Error` with `.what()` message | `Error` / `protobuf.util.ProtocolError` |
| **Bundle size cost** | + nanopb (~30 KB compiled) + per-message generated `.pb.c` | + protobuf.js (~50 KB gz) + reflection JSON |

---

## 4. Most likely cause(s) of user's production crash

Ranked by likelihood given the codebase. **All inferred — no repro yet.**

1. **Cross-thread / wrong-runtime JSI use** — if user calls `NitroProtobuf.encode/decode` from a Reanimated worklet, Skia thread, audio thread, or anywhere other than the JS thread that constructed the HybridObject, behavior is undefined. Common in apps that use Nitro modules to bridge worker-thread serialization. **Check: where in the app is `encode/decode` called?** Look for `runOnUI`, `runOnRuntime`, `worklet`, `requireNativeComponent`, `WorkletEventHandler`, `setNativeReactProps`.

2. **Missing `.options` on a new field** — user added a `string` / `bytes` / `repeated` field in `.proto`, regenerated, but didn't add the matching `.options` entry. Nanopb generator silently emits **callback** field type. First encode/decode of that message → `ensureSupportedField` throw → JS catch maybe missing → app crash. **Check**: diff `proto/*.proto` vs `proto/*.options`; for every `string`/`bytes`/`repeated` field, confirm a matching line in `.options`.

3. **`std::stod` / `std::stoll` on non-numeric string field value** — JS sends `{ price: "" }` or `{ price: "1.2.3" }` for a numeric field → STL exception, surfaces as opaque JS error. If unhandled in the JS catch, RN dev-mode → red box, prod → crash if app has aggressive error boundary that re-throws to native.

4. **Input value > nanopb static buffer** — strings, bytes, or repeated arrays larger than `.options` max → C++ throw. Same propagation concern as #3.

5. **Unknown-field key in JS payload** — adding a field in JS not present in the registry (e.g. typo, or old `.proto` deployed) → `Unknown field: X` throw. Same propagation concern.

6. **`Uint8Array` passed for `bytes`** — fails at JSI converter `canConvert` check **before** reaching C++ → opaque JSI TypeError.

7. **`bytes` decoded base64 → user expects `Uint8Array`** — semantic mismatch, may break downstream parsing logic that calls `Uint8Array.from(base64)` incorrectly. App-level, not a native crash.

8. **Concurrent encode/decode under bursty load** — `std::vector` allocations under contention. Glibc/jemalloc generally fine, but on iOS with libmalloc and 16k-page release builds, repeated huge allocations may hit fragmentation. Low likelihood unless message struct sizes are MB-scale.

9. **Nested message with `init_default = nullptr`** (C3) — would require generator regression. Currently safe but no guardrail.

---

## 5. Recommended fix order

Implement in this order, smallest-blast-radius first. Each is < 20 LoC.

1. **C2 fix** — wrap `std::stod/stoll/stoull` in try/catch returning `false`. Eliminates one class of opaque crashes; preserves the bool-return contract.
2. **C1 fix** — bound `std::string(str, strnlen(str, iter.data_size))` in string decode. Defense in depth.
3. **C3 fix** — null-check `nestedInfo->init_default` in repeated/single Message paths. Matches top-level guard.
4. **G2 fix** — `replace(/^\./, '')` so `type_name` doesn't have leading dot (correctness, not crash).
5. **G4 add** — generator parses `.options` and warns for any string/bytes/repeated field missing limits. **Highest-leverage anti-foot-gun.**
6. **C5 fix** — include actual vs allowed lengths in error messages. Debug aid.
7. **C6 fix** — guard `iter.data_size >= offsetof(pb_bytes_array_t, bytes)` in `setBytesValue`.
8. **C4 / C8 perf** — cache field-by-name index per `MessageInfo` to drop O(n²) walks.
9. **Add fuzz test** — `node --test` case that feeds `decodeMessage` with random / truncated / oversize byte buffers; assert: no SIGSEGV, throws clean exception.
10. **Add cross-thread guard** in `HybridProtobuf::encode/decode` — at construction time capture the runtime ptr; assert in encode/decode that current runtime matches (or just document that calling from worklets is UB).

---

## 6. Crash-repro plan

### iOS sim (lldb)

```bash
cd ~/projects/react-native-nitro-protobuf
bun run example:install
cd example/ios && pod install && cd -
bun run ios
```

Attach lldb from Xcode → exercise:
- Sample payload (should work).
- `name`: 100-char string (exceeds `max_length: 32`) → expect clean throw.
- `scores`: array of 9 (exceeds `max_count: 8`) → expect clean throw.
- `avatar`: 40 bytes (exceeds `max_size: 32`) → expect clean throw.
- `id`: `"not-a-number"` → triggers C2.
- Add a key `bogus: 1` → unknown field throw.
- Modify `proto/extra.proto` to add a `oneof` / `map` field to `User`, regen, retry → exercise `ensureSupportedField`.
- Call encode from a Reanimated worklet (`runOnUI(() => NitroProtobuf.encode(...))`) → suspected SIGSEGV.

Capture every backtrace into `crash-logs/ios-<scenario>.txt`.

### Android emulator (adb logcat)

```bash
bun run android
adb logcat -v threadtime | grep -iE 'nitro|protobuf|fatal|sigsegv|abort|debug'
```

Same matrix. Watch for `SIGSEGV` in frames from `libNitroProtobuf.so`.

### Build/test sanity on macmini

```bash
bun run typecheck        # TS
bun run specs            # nitrogen regen
bun run test             # native round-trip (needs protoc + nanopb + c++)
```

If `protoc` / `protoc-gen-nanopb` missing on macmini:

```bash
brew install protobuf nanopb
```

---

## 7. Out of scope (per plan)

- Adding `oneof` / `map` / proto2-extensions support (would require Nanopb pointer / callback fields, breaking the static-only invariant).
- Migrating off Nanopb to full `libprotobuf` (separate project).
- Publishing fix to npm.

---

## 8. Files audited

| Path | LoC | Purpose |
|------|-----|---------|
| `cpp/ProtobufCodec.hpp` | 14 | Codec interface |
| `cpp/ProtobufCodec.cpp` | 606 | Encode/decode core |
| `cpp/Base64.hpp` | 13 | Base64 interface |
| `cpp/Base64.cpp` | 73 | Standard-alphabet base64 |
| `cpp/HybridProtobuf.hpp` | 16 | JSI bridge interface |
| `cpp/HybridProtobuf.cpp` | 29 | JSI bridge impl |
| `cpp/ProtobufRegistry.hpp` | 56 | `MessageInfo` / `FieldInfo` types |
| `generated/nitro_protobuf_registry.cpp` | 60 | Auto-gen registry (sample) |
| `scripts/generate-protos.mjs` | 322 | proto → registry C++ generator |
| `scripts/run-example.mjs` | — | example runner (not relevant to crash) |
| `src/index.ts` | 7 | JS API entrypoint |
| `src/specs/Protobuf.nitro.ts` | 8 | Nitrogen spec |
| `nitrogen/generated/**` | — | Nitrogen-emitted glue (clean) |
| `ios/Bridge.h` + nitrogen ios | — | iOS glue (clean) |
| `android/CMakeLists.txt` + `build.gradle` + nitrogen android | — | Android glue (clean) |
| `tests/generate-protos.test.mjs` | 158 | Generator unit tests |
| `tests/native-roundtrip.test.mjs` | 348 | End-to-end native compile + run |
| `proto/example.proto` + `example.options` | 17 | Sample schema |
| `example/App.tsx` | 503 | Example RN app exercising round-trip |

Not audited (vendored upstream, considered trusted): `cpp/nanopb/*` (Nanopb v0.4.x), `react-native-nitro-modules` core (already-shipped npm pkg).

# Roadmap

This captures the planned direction for `react-native-nitro-protobuf`, distilled
from user feedback. It is honest about what works today, what is deliberately
out of scope, and what is coming. Priorities are relative, not dated.

Legend: **✅ done** · **🔜 next** · **🧭 planned** · **🧪 exploring** · **🚫 won't do (for now)**

---

## Shipped recently (1.1.0)

- ✅ **Typed per-message API.** Codegen emits `Message.encode(obj)` /
  `Message.decode(bytes)` objects (merged with the message interface) alongside
  the generic `encode(name, obj)` / `decode(name, bytes)`. No magic strings,
  full TypeScript inference.
- ✅ **Well-known types (subset).** `google.protobuf.Timestamp`, `Duration`,
  `Empty`, `FieldMask` and the scalar wrappers (`StringValue`, `Int32Value`, …)
  resolve and round-trip. Natural JS mapping: `Timestamp` ⇄ `Date | string`
  (ISO), `Duration` ⇄ milliseconds (`number`). These are plain static messages,
  so the native codec handles them with no C++ change.
- ✅ **Watch-mode codegen.** `generate --watch` (`npm run proto:watch`)
  regenerates on `.proto` changes (debounced).
- ✅ **Honest benchmarks.** A representative size sweep (~1 KB / 10 KB / 100 KB)
  plus the **base64 / `number[]` boundary-conversion cost** users actually pay
  for `bytes`. See [PERFORMANCE.md](./PERFORMANCE.md).
- ✅ **Docs.** Compatibility matrix, semver/deprecation policy, and the real
  error/validation behavior (see README).

---

## Coverage (schema features)

- 🔜 **`oneof`.** High demand. The registry already marks `oneof` fields; the
  codec rejects them at encode time today. Plan: encode the set member only,
  decode to a single present field (and optionally a generated discriminated
  union in TS). Medium effort — needs codec support + codegen typing.
- 🔜 **`map<K,V>`.** Marked in the registry, rejected by the codec today.
  nanopb models maps as repeated key/value entries; plan is to map them to JS
  objects (string/number keys) in the codec. Medium effort. Workaround now:
  `repeated Entry { key; value; }`.
- 🧭 **`google.protobuf.Struct` / `Value` / `ListValue` / `Any`.** Blocked on
  `map` + `oneof` + recursion. `Struct` ≈ `map<string, Value>`; `Value` is a
  `oneof`. Once map/oneof land, `Struct`/`Value`/`ListValue` map naturally to
  plain JS values; `Any` needs a type-URL registry. Larger effort.
- 🧭 **proto2 syntax.** Currently proto3 only. proto2 explicit presence /
  required / extensions / group fields are a meaningful generator + codec change.
- 🧭 **Explicit field presence (`optional` in proto3).** Distinguish "unset" from
  "default". Needs nanopb `has_` handling surfaced into the AnyMap shape.
- 🧪 **Enums as string literals (option).** Today enums map to `number`. A codegen
  option to emit TS string-literal unions + numeric mapping would improve DX.

## Developer experience

- 🔜 **`Uint8Array` for `bytes` via JSI `ArrayBuffer`.** Today `bytes` decodes to
  a base64 `string` or `number[]`; converting a `Uint8Array` to `number[]` is the
  single most expensive boundary cost we measured (~1.9 ms for 100 KB — see
  PERFORMANCE.md). Passing an `ArrayBuffer`/`Uint8Array` directly across JSI
  would remove it. High value. Needs codec + Nitro spec changes.
- 🧭 **`bigint` option for 64-bit fields.** Today int64/uint64 map to decimal
  **strings** (precision-safe, universally supported). A per-field or global
  `bigint` option for runtimes/uses that prefer it.
- 🧭 **Size inference / warnings.** The generator injects wildcard default field
  limits (256/256/16). Plan: warn when a payload would exceed a field's
  `max_length`/`max_size`/`max_count` at codegen or first-use, and optionally
  infer tighter limits from `.proto` comments/annotations.
- 🧭 **Strict decode mode.** Optionally error (instead of skip) on unknown
  fields, and validate enum values are in range.

## Robustness

- 🔜 **Typed error classes.** Today errors are thrown `Error`s with descriptive
  messages (over-limit, type mismatch, unknown field, unsupported field). Plan:
  structured error types (`NitroProtobufEncodeError` with field + reason) so
  callers can branch without string matching.
- 🧭 **Encode validation hardening.** More precise messages and a documented,
  stable set of validation rules (see README error table) covered by tests.
- 🧪 **Reanimated worklet support.** Calling `encode`/`decode` from a worklet
  thread. Needs the HybridObject to be worklet-installable and thread-safe;
  currently calls are expected on the JS thread. Investigation needed.
- 🧭 **Interop test suite.** Round-trip against the canonical protobuf
  implementations (protoc C++, protobuf.js, ts-proto) for every supported field
  type and the well-known types, in CI, to guarantee wire compatibility.

## Tooling

- 🧭 **Metro plugin / transformer.** Auto-run codegen on `.proto` change inside
  the Metro pipeline (beyond the current `--watch` + Expo config plugin), so JS
  consumers get regenerated types without a separate watcher.
- 🧪 **gRPC companion.** A thin client that pairs this codec with a transport
  (Connect/gRPC-Web). Out of scope for the core codec; likely a separate package.
- 🧭 **Better generator diagnostics.** Point at the offending `.proto` line for
  unsupported constructs and over-limit fields; suggest the `.options` fix.

## API extras

- 🧭 **`size(message)`** — compute encoded length without allocating the buffer
  (nanopb supports this natively via `pb_get_encoded_size`).
- 🧪 **`encodeInto(message, buffer)`** — encode into a caller-provided buffer to
  avoid an allocation. Depends on the JSI `ArrayBuffer` work above.
- 🧭 **Canonical proto3 JSON.** `toJson` / `fromJson` following the proto3 JSON
  mapping (camelCase, base64 bytes, WKT special-casing), distinct from the JS
  shape used by `encode`/`decode`.
- 🧪 **Reflection / descriptors at runtime.** Expose message/field metadata for
  generic tooling. Lower priority.

## Maturity

- ✅ **Compatibility matrix** (README) — RN, New Architecture, Hermes, Nitro,
  Expo SDK, iOS/Android, verified versions.
- ✅ **Semver + deprecation policy** (README).
- 🧭 **Adoption & bus-factor.** More real-world usage, contributors, and a
  documented release/triage process. CI already runs tests + ASan/UBSan fuzz on
  every PR and publishes on tag.

---

## Out of scope (for now) 🚫

- Non-React-Native targets (this is a RN/Nitro module).
- The **Old Architecture** — New Architecture (TurboModules/Fabric) is required.
- A full dynamic/reflection-based runtime codec — the design is intentionally
  static (nanopb) for size and speed.

---

Have a use case that needs one of the **🧭/🧪** items sooner? Open an issue
describing the schema and platform — concrete use cases reprioritize this list.

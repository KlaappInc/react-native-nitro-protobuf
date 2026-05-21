# Roadmap

This captures the planned direction for `react-native-nitro-protobuf`, distilled
from user feedback. It is honest about what works today, what is deliberately
out of scope, and what is coming. Priorities are relative, not dated.

Legend: **✅ done** · **◑ partial** · **🔜 next** · **🧭 planned** · **🧪 exploring** · **🚫 won't do (for now)**

---

## Shipped (1.1.0)

- ✅ **Typed per-message API.** Codegen emits `Message.encode(obj)` /
  `Message.decode(bytes)` objects (merged with the message interface) alongside
  the generic `encode(name, obj)` / `decode(name, bytes)`. No magic strings,
  full TypeScript inference.
- ✅ **Well-known types (subset).** `Timestamp`, `Duration`, `Empty`, `FieldMask`
  and the scalar wrappers, with natural JS mapping (`Timestamp` ⇄ `Date | string`,
  `Duration` ⇄ ms). Plain static messages — no C++ change.
- ✅ **`oneof`.** Encode sets the nanopb `which_<oneof>` selector; decode surfaces
  only the present member. Fuzz-verified.
- ✅ **`map<K,V>`.** Maps to a JS object; the generator synthesizes nanopb's entry
  registration. Fuzz-verified. Map values that are WKTs convert too.
- ✅ **proto2.** optional (has_) / required / repeated / defaults round-trip
  (no extensions or groups).
- ✅ **bigint option** (`--bigint`) and **string enums** (`--enums string`).
- ✅ **Typed error classes.** `ProtobufError` (+ `ProtobufLimitError`,
  `ProtobufFieldError`) with `kind`/`messageName`/`field`; the facade wraps native
  throws via `classifyProtobufError`.
- ✅ **`byteLength()`** (encoded size without allocating) and **reflection**
  (per-message `fields` metadata).
- ✅ **Canonical proto3 JSON** — generated `toJson` / `fromJson`.
- ✅ **Watch-mode codegen** (`generate --watch`) and a **Metro plugin**
  (`withNitroProtobuf`).
- ✅ **Codegen diagnostics** — warns on fields using the default size limits.
- ✅ **Honest benchmarks** — size sweep (~1/10/50 KB) + the base64 / `number[]`
  boundary-conversion cost. See [PERFORMANCE.md](./PERFORMANCE.md).
- ✅ **protobuf.js wire-interop test** in CI.
- ✅ **Docs.** Compatibility matrix, semver/deprecation policy, real error
  behavior.

---

## Coverage (schema features)

- ✅ **`oneof`** (1.1.0). Each member is an optional field; encode sets the
  nanopb `which_<oneof>` selector to the chosen member's tag and writes only that
  union member, decode surfaces only the present member. Verified by round-trip
  (string/int/message members) and ~40k adversarial decodes + bit-flips under the
  ASan/UBSan fuzz harness.
- ✅ **`map<K,V>`** (1.1.0). A map ↔ a JS object (`{ [key]: value }`). The
  generator synthesizes the registration for nanopb's synthetic entry message
  (`<Msg>_<Field>Entry { key=1; value=2 }`, which protobuf.js does not model),
  and the codec encodes/decodes entries via that descriptor; synthetic entry
  types are hidden from `listMessages()`. Verified by round-trip (scalar +
  message values) and ~40k adversarial decodes + bit-flips under ASan/UBSan.
  Map values that are WKTs (e.g. `map<string, Timestamp>`) are converted too.
- 🔜 **`google.protobuf.Struct` / `Value` / `ListValue` / `Any`.** `oneof` + `map`
  now work; the remaining blocker is **recursion**. Confirmed empirically: when
  these are imported, nanopb breaks the cycle by converting the recursive `Value`
  field to **`FT_CALLBACK`** (which the static codec rejects). Shipping them needs
  a dedicated recursive encode/decode for `Struct`/`Value`/`ListValue` wired
  through nanopb callbacks (or a hand-written wire codec), with a **decode depth
  limit** to stay DoS-safe, plus heavy ASan/UBSan fuzzing — a focused multi-day
  task, not a quick add. `Any` also needs a type-URL → message registry (the
  registry already maps names → descriptors, so the lookup is mostly there).
- ◑ **proto2 syntax** (1.1.0). `optional` (explicit presence via nanopb `has_`),
  `required`, `repeated` and field defaults round-trip; unset optionals are
  omitted on decode. **Extensions and groups are not supported** (extensions are
  ignored by the parser; groups should be modeled as nested messages).
- ✅ **Explicit field presence.** proto2 `optional` / proto3 `optional` decode to
  present-or-absent via the nanopb `has_` bit (1.1.0).
- ✅ **Enums as string literals (option).** `--enums string` — done (1.1.0).

## Developer experience

- 🔜 **`Uint8Array` for `bytes` via JSI `ArrayBuffer`.** Today `bytes` decodes to
  a base64 `string` or `number[]`; converting a `Uint8Array` to `number[]` is the
  single most expensive boundary cost we measured (~5 ms for 100 KB — see
  PERFORMANCE.md). **Blocked by a core constraint:** the value crosses JSI inside
  Nitro's `AnyMap`, whose variant has no `ArrayBuffer` member, so per-field bytes
  cannot be a `Uint8Array` without an upstream Nitro `AnyMap` change (or a
  separate non-AnyMap encode path). High value; needs design with the Nitro core.
- ✅ **`bigint` option for 64-bit fields.** `--bigint` — done (1.1.0).
- ✅ **Size inference / warnings.** Non-strict codegen warns on default-limit
  fields — done (1.1.0). (Inferring tighter limits from annotations: still 🧭.)
- 🧭 **Strict decode mode.** Erroring on unknown fields is **not feasible with
  nanopb**, which skips unknown fields by design with no public hook; would need
  a custom decode callback per field. Enum-range validation is feasible separately.

## Robustness

- ✅ **Typed error classes.** `ProtobufError` + `ProtobufLimitError` /
  `ProtobufFieldError` + `classifyProtobufError` — done (1.1.0).
- 🧭 **Encode validation hardening.** More precise messages and a documented,
  stable set of validation rules (see README error table) covered by tests.
- 🧪 **Reanimated worklet support.** Calling `encode`/`decode` from a worklet
  thread. Needs the HybridObject to be worklet-installable and thread-safe;
  currently calls are expected on the JS thread. Investigation needed.
- ◑ **Interop test suite.** protobuf.js wire round-trip is in CI (1.1.0).
  Extending to ts-proto / protoc-C++ and the full WKT matrix is 🧭.

## Tooling

- ✅ **Metro plugin.** `withNitroProtobuf(config, opts)` — done (1.1.0).
- 🧪 **gRPC companion.** A thin client that pairs this codec with a transport
  (Connect/gRPC-Web). Out of scope for the core codec; a separate package.
- ✅ **Better generator diagnostics.** Default-limit warnings — done (1.1.0).
  (Pointing at the exact `.proto` line for unsupported constructs: still 🧭.)

## API extras

- ✅ **`byteLength(message)`** — encoded length without allocating — done (1.1.0).
- 🧪 **`encodeInto(message, buffer)`** — encode into a caller-provided buffer to
  avoid an allocation. Depends on the JSI `ArrayBuffer` work above.
- ✅ **Canonical proto3 JSON** (1.1.0). Generated `toJson` / `fromJson` (generic
  + per-message) following the proto3 JSON mapping: camelCase keys (both accepted
  on input), enum value names, 64-bit as strings, base64 bytes, Timestamp as
  RFC3339, Duration as `"Ns"`, nested messages, repeated + maps. (Struct/Value/
  Any pass through, since they aren't supported — see Coverage.)
- ✅ **Reflection / descriptors at runtime.** Generated `Message.fields`
  metadata — done (1.1.0).

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

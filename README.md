<p align="center">
  <img src="./.github/banner.png" alt="Klaapp - @klaappinc/react-native-nitro-protobuf" width="100%" />
</p>

# react-native-nitro-protobuf

> Blazing-fast Protocol Buffers for React Native, powered by [Nitro Modules](https://nitro.margelo.com) and [nanopb](https://github.com/nanopb/nanopb) (C++).

[![CI](https://github.com/KlaappInc/react-native-nitro-protobuf/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/KlaappInc/react-native-nitro-protobuf/actions/workflows/test.yml)
![platforms](https://img.shields.io/badge/platforms-iOS%20%7C%20Android-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![powered by nitro](https://img.shields.io/badge/powered%20by-nitro-orange)

Encode and decode protobuf messages in C++ directly over JSI - no bridge, no
serialization to JSON in between. You hand it a plain JS object, it returns an
`ArrayBuffer` (and back). On Hermes it encodes **~2-7× faster than protobuf.js**
and produces payloads **~3× smaller than JSON**. See [PERFORMANCE.md](./PERFORMANCE.md).

## Features

- ⚡ **Native C++ codec** (nanopb) over JSI - no bridge round-trips.
- 📦 **Compact wire format** - typically ~3× smaller than JSON.
- 🔧 **Zero-install code generation** - bundled `protoc`; the nanopb generator is
  installed automatically on first run. No `brew`/`pip` setup.
- 🪄 **No hand-written `.options`** - sensible field-size defaults are applied
  automatically; override per field or globally only when you want to.
- 🔒 **Generated TypeScript types** - a typed `Message.encode/decode` object per
  message plus a generic `encode`/`decode`, fully inferred.
- 🕒 **Well-known types** - `Timestamp`, `Duration`, `Empty`, `FieldMask` and the
  scalar wrappers, with natural JS mapping (`Timestamp` ⇄ `Date`, `Duration` ⇄ ms).
- 👀 **Watch mode** - `generate --watch` regenerates on `.proto` changes.
- 📱 **iOS & Android**, New Architecture.
- 🧩 **Expo config plugin** - regenerates on `expo prebuild`.

## Requirements

- React Native with the **New Architecture** enabled.
- [`react-native-nitro-modules`](https://github.com/mrousavy/nitro) (peer dependency).
- Node.js 18+ and **`python3`** (used once to install the code generator; ships
  with macOS and Linux).

## Installation

```sh
npm install @klaappinc/react-native-nitro-protobuf react-native-nitro-modules
```

```sh
cd ios && pod install
```

> **Expo:** add the config plugin to `app.json` and run `npx expo prebuild`.
>
> ```json
> {
>   "plugins": [
>     ["@klaappinc/react-native-nitro-protobuf", { "protoDir": "proto" }]
>   ]
> }
> ```

## Quickstart

```sh
npx react-native-nitro-protobuf init   # scaffold proto/, config, and a script
# edit proto/*.proto …
npm run proto:generate                 # generate C sources, registry, and TS types
cd ios && pod install                  # (re)build with the generated code
```

Define a message:

```proto
// proto/example.proto
syntax = "proto3";
package acme;

message User {
  uint32 id = 1;
  string name = 2;
  repeated int32 scores = 3;
  bool active = 4;
}
```

Use the generated, fully-typed per-message API - no magic strings:

```ts
import { AcmeUser } from './generated/nitro-protobuf'

const user: AcmeUser = { id: 1, name: 'Ada', scores: [10, 20], active: true }

const bytes = AcmeUser.encode(user) // ArrayBuffer
const back = AcmeUser.decode(bytes) // AcmeUser
```

A generic, name-keyed API is also generated (handy for dynamic dispatch):

```ts
import { encode, decode } from './generated/nitro-protobuf'

const bytes = encode('acme.User', user) // name is checked against the schema
const back = decode('acme.User', bytes) // typed as AcmeUser
```

`proto:generate` needs **no system tools**: it uses a bundled `protoc`
(`grpc-tools`) and installs the matching nanopb generator on first run. It writes,
into the package's `generated/` directory (compiled by the pod / CMake):

- `*.pb.h` / `*.pb.c` (nanopb) and `nitro_protobuf_registry.cpp`
- `nitro-protobuf.ts` (to `tsOut`) - typed interfaces plus `encode`/`decode` for
  every message

## Configuration

Optional `nitro-protobuf.config.json` at your project root (CLI flags override it):

```json
{
  "protoDir": "proto",
  "tsOut": "./generated",
  "defaults": { "maxLength": 256, "maxSize": 256, "maxCount": 16 },
  "bigint": false,
  "enums": "number"
}
```

- `bigint: true` (or `--bigint`) types 64-bit fields as `bigint` instead of the
  default precision-safe decimal `string`.
- `enums: "string"` (or `--enums string`) types enums as their value-name
  string-literal union (e.g. `'ADMIN' | 'USER'`) instead of `number`.

The nanopb C sources go to the package's `generated/` (where the pod / CMake
compile them); the typed `nitro-protobuf.ts` goes to `tsOut`. Set `tsOut` to a
folder inside your project (e.g. `./generated`) so you can import it directly -
the examples below assume `./generated/nitro-protobuf`.

### Field size limits

nanopb stores fields in fixed-size C structs, so every `string`, `bytes`, and
`repeated` field needs a maximum. These defaults are applied automatically:

| Option       | Applies to | Default |
| ------------ | ---------- | ------- |
| `max_length` | `string`   | 256     |
| `max_size`   | `bytes`    | 256     |
| `max_count`  | `repeated` | 16      |

Override a specific field with a standard nanopb `<name>.options` file next to
your `.proto` (specific entries win over the defaults):

```
acme.User.name max_length: 32
acme.User.avatar max_size: 1024
```

Pass `--strict` to require an explicit option for every field (no defaults) -
useful for tightly memory-constrained targets.

### CLI

```
react-native-nitro-protobuf <command> [options]

Commands:
  init                  Scaffold proto/, config, and a generate script
  generate              Generate nanopb sources, registry, and TS types (default)

Options:
  --protoDir <path>     Directory with .proto files (default: ./proto)
  --outDir <path>       Output for generated C/registry (default: <module>/generated)
  --tsOut <path>        Output for generated TS types (default: outDir)
  --protoPath <path>    Extra protoc import path (repeatable)
  --protoc <path>       Use a specific protoc (default: bundled)
  --nanopb <path>       Use a specific protoc-gen-nanopb (default: auto-installed)
  --strict              Require explicit .options for every static field
  --bigint              Type 64-bit fields as bigint (default: decimal string)
  --enums <mode>        Enum representation: "string" or "number" (default)
  --watch, -w           Regenerate on .proto changes (debounced)
```

Run `npm run proto:watch` during development to regenerate types as you edit
`.proto` files. Note: TypeScript changes hot-reload through Metro, but **native**
schema changes (new messages/fields) still require a rebuild (`pod install` /
Gradle) since the nanopb C structs are compiled into the app.

## Usage

The generated module gives you type-safe helpers; you can also call the runtime
object directly (untyped):

```ts
import { NitroProtobuf } from '@klaappinc/react-native-nitro-protobuf'

const bytes = NitroProtobuf.encode('acme.User', { id: 1, name: 'Ada' })
const user = NitroProtobuf.decode('acme.User', bytes)
const names = NitroProtobuf.listMessages()
```

### Value mapping (JS ⇄ proto)

| proto type                                          | JS input                          | JS output               |
| --------------------------------------------------- | --------------------------------- | ----------------------- |
| `bool`                                              | `boolean`                         | `boolean`               |
| `int32` / `uint32` / `sint*32` / `fixed32` / `enum` | `number` (or numeric string)      | `number`                |
| `int64` / `uint64` / `fixed64` / `sint64`           | numeric **string**                | numeric **string**      |
| `float` / `double`                                  | `number` (or numeric string)      | `number`                |
| `string`                                            | `string`                          | `string`                |
| `bytes`                                             | base64 `string` **or** `number[]` | base64 `string`         |
| message                                             | object                            | object                  |
| repeated                                            | array                             | array                   |
| `google.protobuf.Timestamp`                         | `Date` **or** ISO `string`        | ISO `string`            |
| `google.protobuf.Duration`                          | `number` (milliseconds)           | `number` (milliseconds) |

- 64-bit integers map to **decimal strings** to avoid JS precision loss.
- `bytes` does **not** accept a `Uint8Array` (rejected at the JSI boundary) - pass
  a base64 string or a `number[]`. This differs from `protobufjs`.
- Numeric strings must be fully numeric; `"12abc"` and `"1.2.3"` are rejected.

### Well-known types

`google.protobuf.Timestamp`, `Duration`, `Empty`, `FieldMask` and the scalar
wrappers (`StringValue`, `Int32Value`, …) work out of the box - just import them:

```proto
import "google/protobuf/timestamp.proto";
import "google/protobuf/duration.proto";

message Session {
  google.protobuf.Timestamp created_at = 1;
  google.protobuf.Duration  ttl        = 2;
}
```

```ts
import { AcmeSession } from './generated/nitro-protobuf'

const bytes = AcmeSession.encode({ created_at: new Date(), ttl: 30_000 }) // ms
const s = AcmeSession.decode(bytes)
s.created_at // ISO string, e.g. "2026-05-21T10:00:00.000Z"
s.ttl // 30000 (ms)
```

`Timestamp` accepts a `Date` or ISO string and decodes to an ISO string;
`Duration` is milliseconds. `Struct`, `Value`, `ListValue` and `Any` are **not**
supported (they need recursive `Value`); see [ROADMAP.md](./ROADMAP.md).

`oneof` is supported: each member is an optional field on the message: set one,
and only the set member is encoded and surfaced on decode. `map<K, V>` is
supported too: a map field maps to a JS object (`{ [key]: value }`).

### Runtime helpers

The generated module also gives you:

```ts
import { AcmeUser, byteLength } from './generated/nitro-protobuf'

// Encoded size without allocating the buffer (typed + per-message).
AcmeUser.byteLength(user) // number
byteLength('acme.User', user) // generic

// Lightweight reflection: field metadata.
AcmeUser.fields // [{ name: 'id', tag: 1, type: 'uint32', repeated: false }, …]

// Canonical proto3 JSON (camelCase keys, RFC3339 timestamps, "1.5s" durations,
// enum names, base64 bytes, 64-bit as strings) - distinct from the binary shape.
const j = AcmeUser.toJson(user) // or toJson('acme.User', user)
const u = AcmeUser.fromJson(j) // or fromJson('acme.User', j)
```

Encode/decode errors are thrown as typed `ProtobufError`s, so you can branch on
`kind` instead of matching message strings:

```ts
import { ProtobufError } from '@klaappinc/react-native-nitro-protobuf'

try {
  AcmeUser.encode(huge)
} catch (e) {
  if (e instanceof ProtobufError && e.kind === 'limit-exceeded') {
    console.warn(`${e.field} is too large`)
  }
}
```

`kind` is one of `unknown-field`, `unsupported-field`, `limit-exceeded`,
`type-mismatch`, `unknown-message`, `decode`, `unknown`; `field` and
`messageName` are populated when known.

### Metro integration

Regenerate on every Metro start (pairs with `proto:generate --watch` for live
edits):

```js
// metro.config.js
const { getDefaultConfig } = require('@react-native/metro-config')
const {
  withNitroProtobuf,
} = require('@klaappinc/react-native-nitro-protobuf/metro')

module.exports = withNitroProtobuf(getDefaultConfig(__dirname), {
  protoDir: 'proto',
})
```

## Performance

On-device (Hermes, Release), `acme.User` (~70 B payload), throughput in ops/sec:

|                                 | encode | decode | wire size |
| ------------------------------- | -----: | -----: | --------: |
| **react-native-nitro-protobuf** | 0.18 M | 0.26 M |  **70 B** |
| protobuf.js                     | 0.07 M | 0.12 M |      70 B |
| JSON                            | 0.44 M | 0.57 M |     210 B |

vs **protobuf.js**: ~2-7× faster encode, ~2× faster decode (medium/large
payloads). vs **JSON**: Hermes' native JSON is faster on raw CPU, but protobuf is
~3× smaller on the wire - choose it when bytes matter (network, storage, IPC).
Full methodology and per-field-type numbers in [PERFORMANCE.md](./PERFORMANCE.md).

## Threading

`encode` and `decode` are **synchronous JSI calls and must run on the JS thread**
(the runtime that created the `Protobuf` HybridObject). Calling them from a
Reanimated worklet, a separate JS runtime, or any other thread is **unsupported
and undefined behaviour** - the most common cause of hard crashes. To
(de)serialize off the main JS thread, marshal the result back first.

## Compatibility

Verified configurations (others likely work but are untested):

|                              | Supported / tested                                                    |
| ---------------------------- | --------------------------------------------------------------------- |
| React Native                 | 0.81 (Expo SDK 54) and 0.85                                           |
| Architecture                 | **New Architecture only** (TurboModules/Fabric); Old Arch unsupported |
| JS engine                    | Hermes                                                                |
| `react-native-nitro-modules` | 0.35.x (peer dependency)                                              |
| Expo                         | SDK 54 (config plugin + dev/prebuild)                                 |
| Platforms                    | iOS 13+, Android (`minSdk` per RN)                                    |
| protobuf syntax              | proto3 + proto2 (no extensions/groups)                                |
| Node (codegen)               | 18+ (plus `python3` once, for the nanopb generator)                   |

## Semantic versioning & deprecation

This package follows [semver](https://semver.org):

- **patch** - fixes, perf, docs; no API or wire-format change.
- **minor** - backward-compatible additions (new codegen output, new options,
  new supported field types). Generated code stays source-compatible.
- **major** - breaking changes to the public TS API, the generated output shape,
  or the JS⇄proto value mapping.

Deprecations are announced in the changelog and kept for at least one minor
release before removal in the next major. The protobuf **wire format is stable**
(it is standard protobuf); upgrades never change bytes on the wire for a given
`.proto`. Releases use [Conventional Commits](https://www.conventionalcommits.org)

- release-please (see [Releasing](#releasing)).

## Errors & validation

`encode`/`decode` **throw** on invalid input - they never silently truncate or
corrupt data. Encode validates against the schema and the field size limits:

| Condition                    | Behavior                                  |
| ---------------------------- | ----------------------------------------- |
| Unknown field name           | throws `Unknown field "<name>" ...`       |
| Wrong JS type for a field    | throws (e.g. expects number/string/array) |
| `string` over `max_length`   | throws `... exceeds max_length ...`       |
| `bytes` over `max_size`      | throws `... exceeds max_size ...`         |
| `repeated` over `max_count`  | throws `... exceeds max_count ...`        |
| non-numeric 64-bit string    | throws (must be a full decimal integer)   |
| `Uint8Array` for `bytes`     | throws (use base64 or `number[]`)         |
| unknown fields on **decode** | skipped (standard proto3 forward-compat)  |

Tune the limits per field in `.options` (see [Field size limits](#field-size-limits)).

## Limitations

- Only nanopb **static** fields are supported (sized via `.options` / defaults).
- A single message must stay **under 64 KB** encoded (nanopb default;
  `PB_FIELD_32BIT` would lift it - see ROADMAP).
- The `Struct`/`Value`/`ListValue`/`Any` well-known types are **not yet
  supported** (they throw with a clear message). `oneof`, `map`, proto2
  (optional/required/repeated/defaults; no extensions/groups), Timestamp,
  Duration, Empty, FieldMask and the scalar wrappers **are** supported.
- 64-bit integers are represented as decimal strings.
- `Uint8Array` is not accepted for `bytes` (use base64 or `number[]`).

See [ROADMAP.md](./ROADMAP.md) for what's planned.

## How it works

```
.proto ──generate──▶ nanopb C structs (*.pb.{h,c}) + registry (message metadata)
                                            │
JS object ◀──▶ Nitro AnyMap ◀──▶ ProtobufCodec (C++) ◀──▶ nanopb wire bytes
```

Your `.proto` is compiled to nanopb static C structures plus a generated registry
that maps message names to their descriptors. At runtime the codec converts a JS
object to a Nitro `AnyMap`, walks the registry to populate the nanopb struct, and
encodes it - and the reverse for decode.

## Troubleshooting

- **Android: "HybridObject 'Protobuf' has not been registered"** - rebuild the
  app after installing/upgrading (the native library is loaded at startup).
- **`python3 not found` during `proto:generate`** - install python3, or pass
  `--nanopb <path to protoc-gen-nanopb>` to use your own generator.
- **A field is missing after decode** - regenerate (`npm run proto:generate`)
  after changing `.proto` files, then rebuild.
- **"Bytes fields must be base64 strings or number arrays"** - don't pass a
  `Uint8Array`; see the value-mapping table.

## Development

```sh
bun install
bun run test     # unit tests + native ASan/UBSan fuzz harness (when toolchain present)
bun run ios      # run the example app
```

The `example/` app is a playground/round-trip demo; `bench/` holds the benchmark
suite used for [PERFORMANCE.md](./PERFORMANCE.md).

CI (`.github/workflows/test.yml`) runs typecheck, build, and the test suite
(including the native ASan/UBSan fuzz harness) on every push and pull request.

## Releasing

Releases are automated with [Conventional Commits](https://www.conventionalcommits.org)
and [release-please](https://github.com/googleapis/release-please):

1. Land changes on `main` using Conventional Commit messages (`feat:`, `fix:`, …).
2. release-please keeps an open "release" PR that bumps the version and updates
   `CHANGELOG.md`. Review and merge it when you want to ship.
3. Merging creates a GitHub Release + tag, which triggers `release.yml` to run the
   test suite and publish `@klaappinc/react-native-nitro-protobuf` to npm.

One-time setup: add an npm automation token as the `NPM_TOKEN` repository secret
(Settings → Secrets and variables → Actions) with publish rights to the
`@klaappinc` scope.

## Contributing

This repo uses **Git Flow**: branch features off `develop` (the default branch)
and open PRs into `develop`; `main` is production and is released automatically.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full branch model and commit
conventions.

## License

MIT © [Klaapp Inc.](https://github.com/KlaappInc)

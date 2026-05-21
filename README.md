# react-native-nitro-protobuf

> Blazing-fast Protocol Buffers for React Native, powered by [Nitro Modules](https://nitro.margelo.com) and [nanopb](https://github.com/nanopb/nanopb) (C++).

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
- 🔒 **Generated TypeScript types** - typed `encode`/`decode` per message.
- 📱 **iOS & Android**, New Architecture.
- 🧩 **Expo config plugin** - regenerates on `expo prebuild`.

## Requirements

- React Native with the **New Architecture** enabled.
- [`react-native-nitro-modules`](https://github.com/mrousavy/nitro) (peer dependency).
- Node.js 18+ and **`python3`** (used once to install the code generator; ships
  with macOS and Linux).

## Installation

```sh
npm install react-native-nitro-protobuf react-native-nitro-modules
```

```sh
cd ios && pod install
```

> **Expo:** add the config plugin to `app.json` and run `npx expo prebuild`.
>
> ```json
> { "plugins": [["react-native-nitro-protobuf", { "protoDir": "proto" }]] }
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

Use the generated, fully-typed API:

```ts
import { encode, decode, type AcmeUser } from './generated/nitro-protobuf'

const user: AcmeUser = { id: 1, name: 'Ada', scores: [10, 20], active: true }

const bytes = encode('acme.User', user) // ArrayBuffer
const back = decode('acme.User', bytes) // AcmeUser
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
  "defaults": { "maxLength": 256, "maxSize": 256, "maxCount": 16 }
}
```

The nanopb C sources go to the package's `generated/` (where the pod / CMake
compile them); the typed `nitro-protobuf.ts` goes to `tsOut`. Set `tsOut` to a
folder inside your project (e.g. `./generated`) so you can import it directly -
the examples below assume `./generated/nitro-protobuf`.

### Field size limits

nanopb stores fields in fixed-size C structs, so every `string`, `bytes`, and
`repeated` field needs a maximum. These defaults are applied automatically:

| Option | Applies to | Default |
|--------|------------|---------|
| `max_length` | `string` | 256 |
| `max_size` | `bytes` | 256 |
| `max_count` | `repeated` | 16 |

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
```

## Usage

The generated module gives you type-safe helpers; you can also call the runtime
object directly (untyped):

```ts
import { NitroProtobuf } from 'react-native-nitro-protobuf'

const bytes = NitroProtobuf.encode('acme.User', { id: 1, name: 'Ada' })
const user = NitroProtobuf.decode('acme.User', bytes)
const names = NitroProtobuf.listMessages()
```

### Value mapping (JS ⇄ proto)

| proto type | JS input | JS output |
|------------|----------|-----------|
| `bool` | `boolean` | `boolean` |
| `int32` / `uint32` / `sint*32` / `fixed32` / `enum` | `number` (or numeric string) | `number` |
| `int64` / `uint64` / `fixed64` / `sint64` | numeric **string** | numeric **string** |
| `float` / `double` | `number` (or numeric string) | `number` |
| `string` | `string` | `string` |
| `bytes` | base64 `string` **or** `number[]` | base64 `string` |
| message | object | object |
| repeated | array | array |

- 64-bit integers map to **decimal strings** to avoid JS precision loss.
- `bytes` does **not** accept a `Uint8Array` (rejected at the JSI boundary) - pass
  a base64 string or a `number[]`. This differs from `protobufjs`.
- Numeric strings must be fully numeric; `"12abc"` and `"1.2.3"` are rejected.

## Performance

On-device (Hermes, Release), `acme.User` (~70 B payload), throughput in ops/sec:

| | encode | decode | wire size |
|--|-------:|-------:|----------:|
| **react-native-nitro-protobuf** | 0.18 M | 0.26 M | **70 B** |
| protobuf.js | 0.07 M | 0.12 M | 70 B |
| JSON | 0.44 M | 0.57 M | 210 B |

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

## Limitations

- Only nanopb **static** fields are supported (sized via `.options` / defaults).
- `oneof`, `map`, proto2, and well-known types are **not supported** (they throw
  at runtime).
- 64-bit integers are represented as strings.
- `Uint8Array` is not accepted for `bytes` (use base64 or `number[]`).

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

## License

MIT © [Klaapp Inc.](https://github.com/KlaappInc)

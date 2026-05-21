# react-native-nitro-protobuf

Nitro + Nanopb bridge for fast protobuf encode/decode on iOS and Android.

## What it does

- Encodes/decodes protobuf messages in C++ (Nanopb).
- JS inputs/outputs are JSON-like `AnyMap` objects.
- Binary payloads are passed as `ArrayBuffer`.

## Quickstart

```
npm install react-native-nitro-protobuf react-native-nitro-modules
npx react-native-nitro-protobuf init     # scaffolds proto/ + config + script
# edit proto/*.proto, then:
npm run proto:generate                    # no protoc/nanopb to install
cd ios && pod install
```

`proto:generate` needs **no system tools**: it uses a bundled `protoc`
(`grpc-tools`) and installs the matching nanopb generator on first run
(requires `python3`, which ships with macOS/Linux). Override with `--protoc` /
`--nanopb` if you prefer your own.

It writes (into the package's `generated/`, compiled by the pod/CMake):

- `*.pb.h` / `*.pb.c` (nanopb) and `nitro_protobuf_registry.cpp`
- `nitro-protobuf.ts` — typed interfaces + `encode`/`decode` for every message

For **Expo**, add the plugin instead of running the script manually — it
regenerates on `expo prebuild`:

```json
{ "plugins": [["react-native-nitro-protobuf", { "protoDir": "proto" }]] }
```

## Field size limits (no hand-written `.options` needed)

Nanopb needs a fixed size for every `string`/`bytes`/`repeated` field. Defaults
are applied automatically (`max_length` 256, `max_size` 256, `max_count` 16), so
your protos compile out of the box. Tune them globally in
`nitro-protobuf.config.json`:

```json
{ "protoDir": "proto", "defaults": { "maxLength": 64, "maxSize": 1024, "maxCount": 32 } }
```

…or per field with a standard nanopb `.proto`-adjacent `<name>.options` file
(specific entries override the defaults):

```
acme.User.name max_length: 32
acme.User.avatar max_size: 1024
```

Pass `--strict` to require an explicit option for every field instead (no
defaults) — useful for tightly memory-constrained targets.

## Usage

Use the generated typed `encode`/`decode` (autocomplete + compile-time checks):

```ts
import { encode, decode, type AcmeUser } from './generated/nitro-protobuf'

const user: AcmeUser = { id: 1, name: 'Ada', scores: [10, 20], active: true }
const bytes = encode('acme.User', user)   // ArrayBuffer
const back = decode('acme.User', bytes)    // AcmeUser
```

Or call the runtime object directly (untyped):

```ts
import { NitroProtobuf } from 'react-native-nitro-protobuf'
const bytes = NitroProtobuf.encode('acme.User', { id: 1, name: 'Ada' })
const names = NitroProtobuf.listMessages()
```

## Threading

`encode`/`decode` are **synchronous JSI calls and must run on the JS thread**
(the runtime that created the `Protobuf` Hybrid Object). Calling them from a
Reanimated worklet, a separate JS runtime, or any non-JS thread is **not
supported and is undefined behaviour** (the most common cause of hard crashes).
If you need to (de)serialize off the main JS thread, marshal the result back to
the JS thread first.

## Value mapping (JS ⇄ proto)

| proto type | JS input | JS output |
|------------|----------|-----------|
| `bool` | `boolean` | `boolean` |
| `int32`/`uint32`/`sint*32`/`fixed32`/`enum` | `number` (or numeric string) | `number` |
| `int64`/`uint64`/`fixed64`/`sint64` | numeric **string** | numeric **string** (avoids precision loss) |
| `float`/`double` | `number` (or numeric string) | `number` |
| `string` | `string` | `string` |
| `bytes` | base64 `string` **or** `number[]` | base64 `string` |
| message | plain object | plain object |
| repeated | array | array |

- Numeric strings must be fully numeric — `"12abc"` / `"1.2.3"` are rejected.
- **`bytes` does NOT accept a `Uint8Array`** — it is rejected at the JSI
  boundary. Pass a base64 string or a `number[]`. (This differs from
  `protobufjs`, which uses `Uint8Array`.)

## Notes and limitations

- Only Nanopb **static** fields are supported. Use `.options` to set:
  - `max_length` for strings
  - `max_size` for bytes
  - `max_count` for repeated fields
- `oneof` and `map` fields are not supported (they throw at runtime).
- 64-bit numbers are returned as strings to avoid precision loss.

## Example protos

See `proto/example.proto` and `proto/example.options` for a minimal setup.

## Tests

```
npm test
```

Native integration coverage runs automatically when `protoc`, `protoc-gen-nanopb`, and a C++ compiler are available. It skips otherwise.

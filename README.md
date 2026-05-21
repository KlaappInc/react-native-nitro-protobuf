# react-native-nitro-protobuf

Nitro + Nanopb bridge for fast protobuf encode/decode on iOS and Android.

## What it does

- Encodes/decodes protobuf messages in C++ (Nanopb).
- JS inputs/outputs are JSON-like `AnyMap` objects.
- Binary payloads are passed as `ArrayBuffer`.

## Install

```
npm install react-native-nitro-protobuf react-native-nitro-modules
```

```
cd ios && pod install
```

## Generate Nanopb sources

1) Install `protoc` and the Nanopb generator:

```
brew install protobuf nanopb
```

2) Put your `.proto` files in your app (example uses `./proto`).
3) Add `.options` files to define `max_length`, `max_size`, and `max_count`.
   **Required:** every `string` (`max_length`), `bytes` (`max_size`), and
   `repeated` field (`max_count`) must have an option, otherwise Nanopb emits a
   *callback* field that this library cannot encode/decode. The generator now
   **fails with an explicit error** listing any field that is missing one.
4) Generate C sources + registry:

```
npx react-native-nitro-protobuf --protoDir ./proto --outDir ./node_modules/react-native-nitro-protobuf/generated
```

The generator writes:

- `generated/*.pb.h` and `generated/*.pb.c`
- `generated/nitro_protobuf_registry.cpp`

## Usage

```ts
import { NitroProtobuf } from 'react-native-nitro-protobuf'

const encoded = NitroProtobuf.encode('nitro.protobuf.UserProfile', {
  id: 1,
  name: 'Ada',
  scores: [10, 20],
  avatar: 'base64...',
  active: true,
})

const decoded = NitroProtobuf.decode('nitro.protobuf.UserProfile', encoded)
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

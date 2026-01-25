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

## Notes and limitations

- Only Nanopb **static** fields are supported. Use `.options` to set:
  - `max_length` for strings
  - `max_size` for bytes
  - `max_count` for repeated fields
- `oneof` and `map` fields are not supported.
- `bytes` fields use base64 strings (encode accepts base64 or `number[]`).
- 64-bit numbers are returned as strings to avoid precision loss.

## Example protos

See `proto/example.proto` and `proto/example.options` for a minimal setup.

## Tests

```
npm test
```

Native integration coverage runs automatically when `protoc`, `protoc-gen-nanopb`, and a C++ compiler are available. It skips otherwise.

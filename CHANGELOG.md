# Changelog

## [1.1.0](https://github.com/KlaappInc/react-native-nitro-protobuf/compare/v1.0.0...v1.1.0) (2026-05-22)


### Features

* add core features ([f262264](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/f262264b857b5cdacae0d3e62e1b71e47f9de4c8))
* bigint + string-enum codegen options, typed errors, size warnings ([cb1c6c8](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/cb1c6c8d41611d68f07080685c013e78dbdeba7d))
* byteLength() + field reflection ([cd12dae](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/cd12daeb7747481fd37559c6b8a23d0b1427695c))
* **codec:** map&lt;K,V&gt; support ([d779a2b](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/d779a2b5e2a9c671178633ee96397ec14f5bdd1c))
* **codec:** oneof support ([a68fa0d](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/a68fa0d3948307c6c3036df81c4e2bcec95961fe))
* **codegen:** canonical proto3 JSON (toJson/fromJson) ([5cf1a51](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/5cf1a511f0615cac34aede1d09369fff35db0649))
* **codegen:** convert map values (WKT/bigint/enum/nested) ([1b14191](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/1b141917aadd7fab799c8dd4b4d13cf6c9e1bcaf))
* **codegen:** typed per-message API, well-known types, watch mode ([671a054](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/671a054f6dc49fd23f31bf27172ae79fe9b23348))
* **dx:** zero-install codegen, default field sizes, TS types, init + Expo plugin ([4ac0b25](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/4ac0b257032abb47d550dc502c2a767554a23cab))
* **generator:** fail on missing nanopb .options; fix escaping & regex ([c75d6c4](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/c75d6c4364847135be0681490d6db811155b3962))
* proto2 syntax support ([b0ed52d](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/b0ed52dad9c96f0599a12f103e59945af4817856))
* **tooling:** protobuf.js wire-interop test + Metro codegen plugin ([2f68aab](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/2f68aabe780e5d5809da510ed6ac445c80267131))


### Bug Fixes

* **android:** eagerly load native lib so HybridObject registers at startup ([6c2a093](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/6c2a09321fd2ab7e82f5392fe67502724c4b72ed))
* **android:** include nitro headers via &lt;NitroModules/...&gt; for prefab ([2e53c41](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/2e53c4107b8158e90270d08eac76e3b8466f3892))
* **build:** compile + resolve well-known-type sources on iOS and Android ([42c0948](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/42c0948c6119296fedb846208e47230dfde364a8))
* **codec:** harden value parsing, string/bytes bounds, nested init ([1a7252d](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/1a7252da7f50f68828e47c053f2497439420e5a9))


### Performance Improvements

* add benchmark suite (native / protobuf.js / JSON / on-device) + report ([b115156](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/b1151566b1f58b7c303ee6ebac53cd6731756d5f))
* **bench:** honest size sweep + bytes boundary-conversion cost ([bf8ab5f](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/bf8ab5fc268193469ddf59a485c1a83c9fbc81a8))
* **codec:** optimize decode/encode hot paths (decode 34-43% faster) ([18e5b45](https://github.com/KlaappInc/react-native-nitro-protobuf/commit/18e5b451e5e5d05fee5769951a07cb2dcef5db15))

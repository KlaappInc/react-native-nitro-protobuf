// Shared benchmark payload profiles for acme.User (see example/proto/example.proto).
//
// One canonical JS object per profile. Each bench (host protobuf.js/JSON, the
// native C++ microbench mirrors these, and the on-device example bench) adapts
// the values to the codec under test:
//   - 64-bit fields (delta/big) are decimal STRINGS (how nitro-protobuf maps
//     int64/uint64). protobuf.js also accepts strings for 64-bit fields.
//   - bytes (avatar) is a number[]; for protobuf.js it is converted to a
//     Uint8Array, for nitro-protobuf it is passed as number[], for JSON as-is.
//
// The C++ microbench (bench/native-bench.cpp) mirrors these exact values.

const str = (n, c = 'x') => c.repeat(n)
const range = (n, start = 0) => Array.from({ length: n }, (_, i) => start + i)

export const PROFILES = {
  tiny: { id: 7 },

  scalars: {
    id: 7,
    active: true,
    delta: '9007199254740993', // 2^53+1: loses precision as a JS number
    big: '9007199254740993',
    ratio: 0.25,
    weight: 82.125,
  },

  string: {
    id: 7,
    name: str(32), // max_length 32
    tags: [str(16, 'a'), str(16, 'b'), str(16, 'c'), str(16, 'd')], // 4 × max_length 16
  },

  bytes: {
    id: 7,
    avatar: range(32), // max_size 32
  },

  repeated: {
    id: 7,
    scores: [10, 20, 30, 40, 50, 60, 70, 80], // max_count 8
    tags: ['a', 'b', 'c', 'd'], // max_count 4
  },

  nested: {
    id: 7,
    address: { street: 'Main St', zip: 12345 },
  },

  // The example app's SAMPLE_PAYLOAD (~70 bytes encoded).
  default: {
    id: 7,
    name: 'Ada',
    active: true,
    delta: '9007199254740993',
    big: '9007199254740993',
    ratio: 0.25,
    weight: 82.125,
    scores: [10, 20],
    tags: ['a', 'b'],
    avatar: [1, 2, 3],
    address: { street: 'Main St', zip: 12345 },
  },

  // Every field at its option-defined maximum.
  large: {
    id: 4294967295,
    name: str(32),
    active: true,
    delta: '9223372036854775807', // INT64_MAX
    big: '18446744073709551615', // UINT64_MAX
    ratio: 3.4028235e38,
    weight: 1.7976931348623157e308,
    scores: range(8, 1),
    tags: [str(16, 'a'), str(16, 'b'), str(16, 'c'), str(16, 'd')],
    avatar: range(32),
    address: { street: str(64, 's'), zip: 4294967295 },
  },
}

// Profile order used in reports.
export const PROFILE_ORDER = [
  'tiny',
  'scalars',
  'string',
  'bytes',
  'repeated',
  'nested',
  'default',
  'large',
]

// ----------------------------------------------------------------------------
// Size sweep: representative ~1KB / ~10KB / ~100KB messages (acme.Blob, see
// bench/proto/blob.proto). Deterministic so the C++ microbench mirrors them
// exactly. Each scale s in {1,10,50} -> text 600*s chars, data 400*s bytes,
// plus a fixed structural tail (4 tags, 4 nested items); ~1KB/10KB/50KB. The
// top size is 50KB, not 100KB: nanopb's default build caps a single message at
// 64KB (PB_FIELD_32BIT off), which is what the library ships. Reports use the
// actual encoded byte size, not the nominal label.
const BLOB_SCALES = { blob1k: 1, blob10k: 10, blob50k: 50 }

export function buildBlob(scale) {
  return {
    text: 'x'.repeat(600 * scale),
    data: Array.from({ length: 400 * scale }, (_, i) => i % 256),
    tags: ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20), 'd'.repeat(20)],
    items: [
      { k: 'k0', v: 0 },
      { k: 'k1', v: 1 },
      { k: 'k2', v: 2 },
      { k: 'k3', v: 3 },
    ],
  }
}

export const BLOB_PROFILES = Object.fromEntries(
  Object.entries(BLOB_SCALES).map(([name, s]) => [name, buildBlob(s)])
)

export const BLOB_ORDER = ['blob1k', 'blob10k', 'blob50k']

// Byte sizes used by the base64-conversion micro-bench (the hidden cost a user
// pays converting a Uint8Array to/from the number[] / base64 the codec uses).
export const BASE64_SIZES = [256, 1024, 10240, 102400]

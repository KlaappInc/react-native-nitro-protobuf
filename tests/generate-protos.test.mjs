import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const scriptPath = path.resolve(
  __dirname,
  '..',
  'scripts',
  'generate-protos.mjs'
)

function runGenerator(args, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  })
}

function writeProto(dir, name, contents) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), contents, 'utf8')
}

test('generates registry for simple protos', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')

  writeProto(
    protoDir,
    'example.proto',
    [
      'syntax = "proto3";',
      'package acme;',
      '',
      'message User {',
      '  uint32 id = 1;',
      '  string name = 2;',
      '  bytes avatar = 3;',
      '  repeated int32 scores = 4;',
      '  bool active = 5;',
      '}',
      '',
      'message Event {',
      '  string title = 1;',
      '}',
      '',
      'message Wrapper {',
      '  User user = 1;',
      '  Event event = 2;',
      '}',
    ].join('\n')
  )

  const result = runGenerator(
    ['--protoDir', protoDir, '--outDir', outDir, '--skipProtoc'],
    tmp
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const registry = fs.readFileSync(
    path.join(outDir, 'nitro_protobuf_registry.cpp'),
    'utf8'
  )
  assert.match(
    registry,
    /\{"acme\.User",\s*&acme_User_msg,\s*sizeof\(acme_User\)/
  )
  assert.match(
    registry,
    /\{"name",\s*2,\s*FieldType::String,\s*false,\s*false,\s*false/
  )
  assert.match(
    registry,
    /\{"avatar",\s*3,\s*FieldType::Bytes,\s*false,\s*false,\s*false/
  )
  assert.match(
    registry,
    /\{"scores",\s*4,\s*FieldType::Int32,\s*true,\s*false,\s*false/
  )
  assert.match(registry, /"acme\.User"/)
  assert.match(registry, /"acme\.Event"/)
})

test('marks map and oneof fields', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')

  writeProto(
    protoDir,
    'map.proto',
    [
      'syntax = "proto3";',
      'package acme;',
      '',
      'message Config {',
      '  map<string, int32> labels = 1;',
      '  oneof choice {',
      '    string name = 2;',
      '    int32 age = 3;',
      '  }',
      '}',
    ].join('\n')
  )

  const result = runGenerator(
    ['--protoDir', protoDir, '--outDir', outDir, '--skipProtoc'],
    tmp
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const registry = fs.readFileSync(
    path.join(outDir, 'nitro_protobuf_registry.cpp'),
    'utf8'
  )
  assert.match(
    registry,
    /\{"labels",\s*1,\s*FieldType::\w+,\s*false,\s*false,\s*true/
  )
  assert.match(
    registry,
    /\{"name",\s*2,\s*FieldType::String,\s*false,\s*true,\s*false/
  )
  assert.match(
    registry,
    /\{"age",\s*3,\s*FieldType::Int32,\s*false,\s*true,\s*false/
  )
})

test('proto2 generates (required / optional / repeated)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')

  writeProto(
    protoDir,
    'p2.proto',
    [
      'syntax = "proto2";',
      'package acme;',
      'message P2 {',
      '  required uint32 id = 1;',
      '  optional string name = 2 [default = "anon"];',
      '  repeated int32 nums = 3;',
      '}',
    ].join('\n')
  )
  const ok = runGenerator(
    ['--protoDir', protoDir, '--outDir', outDir, '--skipProtoc'],
    tmp
  )
  assert.equal(ok.status, 0, ok.stderr || ok.stdout)
  const registry = fs.readFileSync(
    path.join(outDir, 'nitro_protobuf_registry.cpp'),
    'utf8'
  )
  assert.match(registry, /"acme\.P2"/)
  assert.match(registry, /\{"id",\s*1,\s*FieldType::UInt32/)
  const types = fs.readFileSync(path.join(outDir, 'nitro-protobuf.ts'), 'utf8')
  assert.match(types, /name\?: string/)
  assert.match(types, /nums\?: \(number\)\[\]/)
})

test('map fields type as objects; map values convert (WKT)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')

  writeProto(
    protoDir,
    'cal.proto',
    [
      'syntax = "proto3";',
      'package acme;',
      'import "google/protobuf/timestamp.proto";',
      'message Cal {',
      '  map<string, google.protobuf.Timestamp> events = 1;',
      '  map<string, int32> plain = 2;',
      '}',
    ].join('\n')
  )
  const result = runGenerator(
    ['--protoDir', protoDir, '--outDir', outDir, '--skipProtoc'],
    tmp
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const types = fs.readFileSync(path.join(outDir, 'nitro-protobuf.ts'), 'utf8')
  assert.match(types, /events\?: \{ \[key: string\]: Date \| string \}/)
  assert.match(types, /plain\?: \{ \[key: string\]: number \}/)
  // Map of Timestamp converts per-value (m:ts); plain int32 map needs no conv.
  assert.match(types, /"events":"m:ts"/)
  assert.doesNotMatch(types, /"plain":/)
})

test('resolves well-known types and emits typed API + conversions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')

  writeProto(
    protoDir,
    'evt.proto',
    [
      'syntax = "proto3";',
      'package acme;',
      '',
      'import "google/protobuf/timestamp.proto";',
      'import "google/protobuf/duration.proto";',
      'import "google/protobuf/field_mask.proto";',
      '',
      'message Event {',
      '  string id = 1;',
      '  google.protobuf.Timestamp created_at = 2;',
      '  google.protobuf.Duration ttl = 3;',
      '  google.protobuf.FieldMask mask = 4;',
      '  repeated google.protobuf.Timestamp checkpoints = 5;',
      '}',
    ].join('\n')
  )

  // --skipProtoc still resolves imports via protobuf.js (no nanopb needed).
  const result = runGenerator(
    ['--protoDir', protoDir, '--outDir', outDir, '--skipProtoc'],
    tmp
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const registry = fs.readFileSync(
    path.join(outDir, 'nitro_protobuf_registry.cpp'),
    'utf8'
  )
  // WKT messages are registered so nested fields resolve in the codec.
  assert.match(registry, /"google\.protobuf\.Timestamp"/)
  assert.match(registry, /"google\.protobuf\.Duration"/)
  assert.match(registry, /"google\.protobuf\.FieldMask"/)
  assert.match(registry, /#include "google\/protobuf\/timestamp\.pb\.h"/)

  const types = fs.readFileSync(path.join(outDir, 'nitro-protobuf.ts'), 'utf8')
  // Natural JS mapping for Timestamp / Duration.
  assert.match(types, /created_at\?: Date \| string/)
  assert.match(types, /ttl\?: number/)
  assert.match(types, /checkpoints\?: \(Date \| string\)\[\]/)
  // Spec-driven conversion table + typed per-message object.
  assert.match(
    types,
    /"acme\.Event":\{"created_at":"ts","ttl":"dur","checkpoints":"ts"\}/
  )
  assert.match(types, /export const AcmeEvent = \{/)
  assert.match(types, /messageName: 'acme\.Event' as const/)
  assert.match(types, /_toTimestamp|_fromTimestamp/)
})

test('--bigint and --enums string change the generated types + conversions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')

  writeProto(
    protoDir,
    'm.proto',
    [
      'syntax = "proto3";',
      'package acme;',
      'enum Role { ROLE_UNSPECIFIED = 0; ADMIN = 1; USER = 2; }',
      'message Account {',
      '  int64 balance = 1;',
      '  Role role = 2;',
      '  repeated uint64 ledger = 3;',
      '}',
    ].join('\n')
  )

  const result = runGenerator(
    [
      '--protoDir',
      protoDir,
      '--outDir',
      outDir,
      '--skipProtoc',
      '--bigint',
      '--enums',
      'string',
    ],
    tmp
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const types = fs.readFileSync(path.join(outDir, 'nitro-protobuf.ts'), 'utf8')
  assert.match(types, /balance\?: bigint/)
  assert.match(types, /ledger\?: \(bigint\)\[\]/)
  assert.match(types, /role\?: 'ROLE_UNSPECIFIED' \| 'ADMIN' \| 'USER'/)
  assert.match(types, /"balance":"i64"/)
  assert.match(types, /"role":"e:acme_Role"/)
  assert.match(types, /"ADMIN":1/)
  assert.match(types, /return BigInt\(v\)/)

  // Default (no flags): 64-bit stays string, enum stays number.
  const def = path.join(tmp, 'gen-default')
  const r2 = runGenerator(
    ['--protoDir', protoDir, '--outDir', def, '--skipProtoc'],
    tmp
  )
  assert.equal(r2.status, 0, r2.stderr || r2.stdout)
  const t2 = fs.readFileSync(path.join(def, 'nitro-protobuf.ts'), 'utf8')
  assert.match(t2, /balance\?: string/)
  assert.match(t2, /role\?: number/)
})

test('fails when proto directory is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-'))
  const protoDir = path.join(tmp, 'missing')
  const outDir = path.join(tmp, 'generated')

  const result = runGenerator(
    ['--protoDir', protoDir, '--outDir', outDir, '--skipProtoc'],
    tmp
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /Proto directory not found/)
})

test('fails when no proto files are found', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')
  fs.mkdirSync(protoDir, { recursive: true })

  const result = runGenerator(
    ['--protoDir', protoDir, '--outDir', outDir, '--skipProtoc'],
    tmp
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /No \.proto files found/)
})

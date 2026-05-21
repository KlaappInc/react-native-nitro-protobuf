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

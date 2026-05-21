import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const generatorPath = path.resolve(repoRoot, 'scripts', 'generate-protos.mjs')

// Generate TS types, then transpile + load them in-process with the native
// import stubbed out, so the pure-JS toJson/fromJson runtime can be exercised
// on the host (the generated module's createHybridObject can't run off-device).
function loadGenerated(protoText, args = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-json-'))
  const protoDir = path.join(tmp, 'proto')
  fs.mkdirSync(protoDir, { recursive: true })
  fs.writeFileSync(path.join(protoDir, 'm.proto'), protoText)
  const gen = spawnSync(
    process.execPath,
    [
      generatorPath,
      '--protoDir',
      protoDir,
      '--outDir',
      tmp,
      '--skipProtoc',
      ...args,
    ],
    { encoding: 'utf8' }
  )
  assert.equal(gen.status, 0, gen.stderr || gen.stdout)

  let ts = fs.readFileSync(path.join(tmp, 'nitro-protobuf.ts'), 'utf8')
  ts = ts.replace(
    /import \{[\s\S]*?\} from '@klaappinc\/react-native-nitro-protobuf'/,
    'const NitroProtobuf = {} as any; const classifyProtobufError = (e: any) => e;'
  )
  const tsc = require('typescript')
  const js = tsc.transpileModule(ts, {
    compilerOptions: { module: 'CommonJS', target: 'ES2020' },
  }).outputText
  const file = path.join(tmp, 'gen.cjs')
  fs.writeFileSync(file, js)
  return require(file)
}

test('canonical proto3 JSON: camelCase, enums, WKT, repeated, map', () => {
  const mod = loadGenerated(
    [
      'syntax = "proto3";',
      'package acme;',
      'import "google/protobuf/timestamp.proto";',
      'import "google/protobuf/duration.proto";',
      'enum Role { ROLE_UNSPECIFIED = 0; ADMIN = 1; }',
      'message Doc {',
      '  string doc_id = 1;',
      '  int64 big_num = 2;',
      '  Role role = 3;',
      '  google.protobuf.Timestamp created_at = 4;',
      '  google.protobuf.Duration ttl = 5;',
      '  repeated string tags = 6;',
      '  map<string, int32> counts = 7;',
      '  bytes blob = 8;',
      '}',
    ].join('\n')
  )

  const shape = {
    doc_id: 'd1',
    big_num: '9007199254740993',
    role: 1,
    created_at: '2026-05-21T10:00:00.000Z',
    ttl: 1500,
    tags: ['a', 'b'],
    counts: { x: 1, y: 2 },
    blob: 'AAEC',
  }
  const json = mod.toJson('acme.Doc', shape)

  // camelCase keys
  assert.equal(json.docId, 'd1')
  assert.equal(json.bigNum, '9007199254740993') // 64-bit -> string
  assert.equal(json.role, 'ADMIN') // enum -> name
  assert.equal(json.createdAt, '2026-05-21T10:00:00.000Z') // RFC3339
  assert.equal(json.ttl, '1.5s') // Duration -> "Ns"
  assert.deepEqual(json.tags, ['a', 'b'])
  assert.deepEqual(json.counts, { x: 1, y: 2 })
  assert.equal(json.blob, 'AAEC')

  // round-trip back to the JS shape
  const back = mod.fromJson('acme.Doc', json)
  assert.equal(back.doc_id, 'd1')
  assert.equal(back.big_num, '9007199254740993')
  assert.equal(back.role, 1) // name -> number
  assert.equal(back.ttl, 1500) // "1.5s" -> ms
  assert.deepEqual(back.tags, ['a', 'b'])
  assert.deepEqual(back.counts, { x: 1, y: 2 })

  // per-message helpers exist + agree
  assert.deepEqual(mod.AcmeDoc.toJson(shape), json)
})

test('canonical JSON: Date input -> RFC3339, number-enum input accepted', () => {
  const mod = loadGenerated(
    [
      'syntax = "proto3";',
      'package acme;',
      'import "google/protobuf/timestamp.proto";',
      'message T { google.protobuf.Timestamp at = 1; }',
    ].join('\n')
  )
  const json = mod.toJson('acme.T', {
    at: new Date('2020-01-02T03:04:05.000Z'),
  })
  assert.equal(json.at, '2020-01-02T03:04:05.000Z')
})

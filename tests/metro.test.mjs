import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { withNitroProtobuf } = require('../metro.js')

test('withNitroProtobuf returns the config unchanged when proto dir is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-metro-'))
  const config = { resolver: { sourceExts: ['ts'] } }
  const out = withNitroProtobuf(config, { protoDir: 'nope', cwd: tmp })
  assert.equal(out, config) // same object, unchanged
})

test('withNitroProtobuf runs codegen and returns the config when proto dir exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-metro-'))
  const protoDir = path.join(tmp, 'proto')
  fs.mkdirSync(protoDir, { recursive: true })
  fs.writeFileSync(
    path.join(protoDir, 'm.proto'),
    'syntax = "proto3";\npackage app;\nmessage M { uint32 id = 1; }\n'
  )
  const config = { transformer: {} }
  const genDir = path.join(tmp, 'gen')
  const out = withNitroProtobuf(config, {
    protoDir: 'proto',
    outDir: genDir,
    cwd: tmp,
    skipProtoc: true, // types + registry only -> no protoc/nanopb needed
  })
  assert.equal(out, config)
  assert.ok(fs.existsSync(path.join(genDir, 'nitro-protobuf.ts')))
  assert.ok(fs.existsSync(path.join(genDir, 'nitro_protobuf_registry.cpp')))
})

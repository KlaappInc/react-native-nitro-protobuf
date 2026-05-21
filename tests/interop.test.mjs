import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import protobuf from 'protobufjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const generatorPath = path.resolve(repoRoot, 'scripts', 'generate-protos.mjs')

function findExecutable(name) {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter)
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : ['']
  for (const entry of pathEntries) {
    for (const ext of exts) {
      const c = path.join(entry, `${name}${ext}`)
      if (fs.existsSync(c)) return c
    }
  }
  return null
}
const pickCompiler = () =>
  findExecutable('c++') ?? findExecutable('clang++') ?? findExecutable('g++')
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', ...opts })

// Wire-compatibility with the canonical protobuf.js implementation: a message
// encoded by protobuf.js decodes + re-encodes through the native codec, and the
// result decodes back to the same object in protobuf.js. Proves the codec reads
// and writes standard protobuf wire bytes (not a private framing).
test('protobuf.js <-> native codec wire interop', (t) => {
  const protoc = process.env.PROTOC ?? findExecutable('protoc')
  const nanopbPlugin =
    process.env.NANOPB_PLUGIN ??
    process.env.NANOPB_PROTOC_GEN ??
    findExecutable('protoc-gen-nanopb')
  const compiler = pickCompiler()
  if (!protoc) return t.skip('protoc not available')
  if (!nanopbPlugin) return t.skip('protoc-gen-nanopb not available')
  if (!compiler) return t.skip('C++ compiler not available')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-interop-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')
  fs.mkdirSync(protoDir, { recursive: true })

  const proto = [
    'syntax = "proto3";',
    'package acme;',
    'message Address { string street = 1; uint32 zip = 2; }',
    'message User {',
    '  uint32 id = 1;',
    '  string name = 2;',
    '  bytes avatar = 3;',
    '  repeated int32 scores = 4;',
    '  bool active = 5;',
    '  Address address = 6;',
    '  repeated string tags = 7;',
    '  int64 delta = 8;',
    '}',
  ].join('\n')
  fs.writeFileSync(path.join(protoDir, 'example.proto'), proto, 'utf8')

  const gen = run(process.execPath, [
    generatorPath,
    '--protoDir',
    protoDir,
    '--outDir',
    outDir,
    '--protoc',
    protoc,
    '--nanopb',
    nanopbPlugin,
  ])
  assert.equal(gen.status, 0, gen.stderr || gen.stdout)

  // 1. Encode a sample with protobuf.js -> wire bytes.
  const root = protobuf.loadSync(path.join(protoDir, 'example.proto'))
  const User = root.lookupType('acme.User')
  const Long = protobuf.util.Long
  const sample = {
    id: 7,
    name: 'Ada',
    avatar: Uint8Array.from([1, 2, 3, 250]),
    scores: [10, 20, 30],
    active: true,
    address: { street: 'Main St', zip: 12345 },
    tags: ['alpha', 'beta'],
    delta: Long.fromString('9007199254740993', false),
  }
  assert.equal(User.verify(sample), null)
  const inBytes = User.encode(User.create(sample)).finish()
  const inPath = path.join(tmp, 'in.bin')
  const outPath = path.join(tmp, 'out.bin')
  fs.writeFileSync(inPath, inBytes)

  // 2. Native: read protobuf.js bytes, decode, re-encode, write back.
  const testCpp = path.join(tmp, 'interop.cpp')
  fs.writeFileSync(
    testCpp,
    [
      '#include "ProtobufCodec.hpp"',
      '#include "ProtobufRegistry.hpp"',
      '#include "AnyMap.hpp"',
      '#include <fstream>',
      '#include <vector>',
      '#include <iostream>',
      'using namespace margelo::nitro;',
      'using namespace margelo::nitro::nitroprotobuf;',
      'int main(int argc, char** argv) {',
      '  if (argc < 3) return 2;',
      '  std::ifstream in(argv[1], std::ios::binary);',
      '  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());',
      '  const MessageInfo* info = getMessageInfo("acme.User");',
      '  if (!info) { std::cerr << "no acme.User"; return 3; }',
      '  auto buf = ArrayBuffer::copy(bytes.data(), bytes.size());',
      '  auto decoded = decodeMessage(*info, buf);',
      '  auto reencoded = encodeMessage(*info, decoded);',
      '  std::ofstream out(argv[2], std::ios::binary);',
      '  out.write(reinterpret_cast<const char*>(reencoded->data()), reencoded->size());',
      '  return 0;',
      '}',
    ].join('\n'),
    'utf8'
  )

  const pbSources = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.name.endsWith('.pb.c')) pbSources.push(f)
    }
  }
  walk(outDir)

  const shim = path.join(tmp, 'nm-shim')
  fs.mkdirSync(shim, { recursive: true })
  fs.symlinkSync(
    path.join(
      repoRoot,
      'node_modules',
      'react-native-nitro-modules',
      'cpp',
      'core'
    ),
    path.join(shim, 'NitroModules')
  )

  const sources = [
    testCpp,
    path.join(repoRoot, 'cpp', 'ProtobufCodec.cpp'),
    path.join(repoRoot, 'cpp', 'Base64.cpp'),
    path.join(
      repoRoot,
      'node_modules',
      'react-native-nitro-modules',
      'cpp',
      'core',
      'AnyMap.cpp'
    ),
    path.join(
      repoRoot,
      'node_modules',
      'react-native-nitro-modules',
      'cpp',
      'core',
      'ArrayBuffer.cpp'
    ),
    path.join(
      repoRoot,
      'node_modules',
      'react-native',
      'ReactCommon',
      'jsi',
      'jsi',
      'jsi.cpp'
    ),
    path.join(
      repoRoot,
      'node_modules',
      'react-native',
      'ReactCommon',
      'jsi',
      'jsi',
      'jsilib-posix.cpp'
    ),
    path.join(repoRoot, 'cpp', 'nanopb', 'pb_common.c'),
    path.join(repoRoot, 'cpp', 'nanopb', 'pb_encode.c'),
    path.join(repoRoot, 'cpp', 'nanopb', 'pb_decode.c'),
    path.join(outDir, 'nitro_protobuf_registry.cpp'),
    ...pbSources,
  ]
  const includes = [
    shim,
    path.join(repoRoot, 'cpp'),
    path.join(repoRoot, 'cpp', 'nanopb'),
    path.join(
      repoRoot,
      'node_modules',
      'react-native-nitro-modules',
      'cpp',
      'core'
    ),
    path.join(
      repoRoot,
      'node_modules',
      'react-native-nitro-modules',
      'cpp',
      'utils'
    ),
    path.join(repoRoot, 'node_modules', 'react-native', 'ReactCommon', 'jsi'),
    outDir,
  ]
  const binary = path.join(tmp, 'interop')
  const compile = run(compiler, [
    '-std=c++20',
    ...includes.flatMap((d) => ['-I', d]),
    ...sources,
    '-o',
    binary,
  ])
  assert.equal(compile.status, 0, compile.stderr || compile.stdout)

  const exec = run(binary, [inPath, outPath])
  assert.equal(exec.status, 0, exec.stderr || exec.stdout)

  // 3. protobuf.js decodes the native-produced bytes -> must match the sample.
  const outBytes = fs.readFileSync(outPath)
  const back = User.toObject(User.decode(outBytes), {
    longs: String,
    bytes: Array,
    defaults: true,
  })
  assert.equal(back.id, 7)
  assert.equal(back.name, 'Ada')
  assert.equal(back.active, true)
  assert.deepEqual(back.scores, [10, 20, 30])
  assert.deepEqual(back.tags, ['alpha', 'beta'])
  assert.equal(back.address.street, 'Main St')
  assert.equal(back.address.zip, 12345)
  assert.equal(back.delta, '9007199254740993')
  assert.deepEqual(Array.from(back.avatar), [1, 2, 3, 250])
})

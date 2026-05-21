import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const generatorPath = path.resolve(repoRoot, 'scripts', 'generate-protos.mjs')
const harnessPath = path.resolve(__dirname, 'harness.cpp')

function findExecutable(name) {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter)
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : ['']
  for (const entry of pathEntries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, `${name}${ext}`)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

function pickCompiler() {
  return findExecutable('clang++') ?? findExecutable('c++') ?? findExecutable('g++')
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

test('decode/encode fuzz under ASan/UBSan (no memory errors)', (t) => {
  const protoc = process.env.PROTOC ?? findExecutable('protoc')
  if (!protoc) return t.skip('protoc not available')
  const nanopbPlugin =
    process.env.NANOPB_PLUGIN ??
    process.env.NANOPB_PROTOC_GEN ??
    findExecutable('protoc-gen-nanopb')
  if (!nanopbPlugin) return t.skip('protoc-gen-nanopb not available')
  const compiler = pickCompiler()
  if (!compiler) return t.skip('C++ compiler not available')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-fuzz-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')
  fs.mkdirSync(protoDir, { recursive: true })

  // Matches the message/field shape harness.cpp expects (acme.User/acme.Address).
  fs.writeFileSync(
    path.join(protoDir, 'example.proto'),
    [
      'syntax = "proto3";',
      'package acme;',
      '',
      'message Address {',
      '  string street = 1;',
      '  uint32 zip = 2;',
      '}',
      '',
      'message User {',
      '  uint32 id = 1;',
      '  string name = 2;',
      '  bytes avatar = 3;',
      '  repeated int32 scores = 4;',
      '  bool active = 5;',
      '  Address address = 6;',
      '  repeated string tags = 7;',
      '  int64 delta = 8;',
      '  uint64 big = 9;',
      '  float ratio = 10;',
      '  double weight = 11;',
      '}',
      '',
      'message Inner { string label = 1; }',
      'message Pick {',
      '  uint32 id = 1;',
      '  oneof choice {',
      '    string name = 2;',
      '    int32 age = 3;',
      '    Inner inner = 4;',
      '  }',
      '}',
    ].join('\n'),
    'utf8'
  )
  fs.writeFileSync(
    path.join(protoDir, 'example.options'),
    [
      'acme.Address.street max_length: 64',
      'acme.User.name max_length: 32',
      'acme.User.avatar max_size: 32',
      'acme.User.scores max_count: 8',
      'acme.User.tags max_length: 16',
      'acme.User.tags max_count: 4',
    ].join('\n'),
    'utf8'
  )

  const generate = run(
    process.execPath,
    [generatorPath, '--protoDir', protoDir, '--outDir', outDir, '--protoc', protoc, '--nanopb', nanopbPlugin],
    { cwd: tmp }
  )
  assert.equal(generate.status, 0, generate.stderr || generate.stdout)

  const pbSources = fs
    .readdirSync(outDir)
    .filter((n) => n.endsWith('.pb.c'))
    .map((n) => path.join(outDir, n))

  const sources = [
    harnessPath,
    path.join(repoRoot, 'cpp', 'ProtobufCodec.cpp'),
    path.join(repoRoot, 'cpp', 'Base64.cpp'),
    path.join(repoRoot, 'node_modules', 'react-native-nitro-modules', 'cpp', 'core', 'AnyMap.cpp'),
    path.join(repoRoot, 'node_modules', 'react-native-nitro-modules', 'cpp', 'core', 'ArrayBuffer.cpp'),
    path.join(repoRoot, 'node_modules', 'react-native', 'ReactCommon', 'jsi', 'jsi', 'jsi.cpp'),
    path.join(repoRoot, 'node_modules', 'react-native', 'ReactCommon', 'jsi', 'jsi', 'jsilib-posix.cpp'),
    path.join(repoRoot, 'cpp', 'nanopb', 'pb_common.c'),
    path.join(repoRoot, 'cpp', 'nanopb', 'pb_encode.c'),
    path.join(repoRoot, 'cpp', 'nanopb', 'pb_decode.c'),
    path.join(outDir, 'nitro_protobuf_registry.cpp'),
    ...pbSources,
  ]
  // `NitroModules/` shim so the codec's `<NitroModules/...>` includes resolve
  // in a raw host compile (the package only ships the flat cpp/core layout;
  // the prefixed form is provided by iOS pods / Android prefab at build time).
  const shim = path.join(tmp, 'nm-shim')
  fs.mkdirSync(shim, { recursive: true })
  fs.symlinkSync(
    path.join(repoRoot, 'node_modules', 'react-native-nitro-modules', 'cpp', 'core'),
    path.join(shim, 'NitroModules')
  )

  const includes = [
    shim,
    path.join(repoRoot, 'cpp'),
    path.join(repoRoot, 'cpp', 'nanopb'),
    path.join(repoRoot, 'node_modules', 'react-native-nitro-modules', 'cpp', 'core'),
    path.join(repoRoot, 'node_modules', 'react-native-nitro-modules', 'cpp', 'utils'),
    path.join(repoRoot, 'node_modules', 'react-native', 'ReactCommon', 'jsi'),
    outDir,
  ]

  const binary = path.join(tmp, 'fuzz')
  const compile = run(
    compiler,
    [
      '-std=c++20',
      '-g',
      '-O1',
      '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer',
      ...includes.flatMap((d) => ['-I', d]),
      ...sources,
      '-o',
      binary,
    ],
    { cwd: tmp }
  )
  assert.equal(compile.status, 0, compile.stderr || compile.stdout)

  const execute = run(binary, [], {
    cwd: tmp,
    env: { ...process.env, ASAN_OPTIONS: 'halt_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' },
  })
  assert.equal(execute.status, 0, execute.stderr || execute.stdout)
})

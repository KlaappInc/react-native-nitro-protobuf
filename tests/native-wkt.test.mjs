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
  return (
    findExecutable('c++') ?? findExecutable('clang++') ?? findExecutable('g++')
  )
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

// Collect *.pb.c recursively (WKT sources land under google/protobuf/).
function collectPbSources(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectPbSources(full))
    else if (entry.name.endsWith('.pb.c')) out.push(full)
  }
  return out
}

// Round-trip a message with nested well-known types through the native codec.
// The codec treats Timestamp/Duration/FieldMask as plain static messages, so
// this proves WKT imports resolve, get registered, and nest correctly. The
// JS-side Date<->Timestamp / ms<->Duration mapping is generated TS (covered by
// the generator test and the on-device example).
test('native round-trip of well-known types', (t) => {
  const protoc = process.env.PROTOC ?? findExecutable('protoc')
  if (!protoc) {
    t.skip('protoc not available')
    return
  }
  const nanopbPlugin =
    process.env.NANOPB_PLUGIN ??
    process.env.NANOPB_PROTOC_GEN ??
    findExecutable('protoc-gen-nanopb')
  if (!nanopbPlugin) {
    t.skip('protoc-gen-nanopb not available')
    return
  }
  const compiler = pickCompiler()
  if (!compiler) {
    t.skip('C++ compiler not available')
    return
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-wkt-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')
  fs.mkdirSync(protoDir, { recursive: true })

  fs.writeFileSync(
    path.join(protoDir, 'evt.proto'),
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
    ].join('\n'),
    'utf8'
  )

  const generate = run(
    process.execPath,
    [
      generatorPath,
      '--protoDir',
      protoDir,
      '--outDir',
      outDir,
      '--protoc',
      protoc,
      '--nanopb',
      nanopbPlugin,
    ],
    { cwd: tmp }
  )
  assert.equal(generate.status, 0, generate.stderr || generate.stdout)

  const testCpp = path.join(tmp, 'wkt.cpp')
  fs.writeFileSync(
    testCpp,
    [
      '#include "ProtobufCodec.hpp"',
      '#include "ProtobufRegistry.hpp"',
      '#include "AnyMap.hpp"',
      '#include <iostream>',
      '#include <string>',
      '',
      'using namespace margelo::nitro;',
      'using namespace margelo::nitro::nitroprotobuf;',
      '',
      'int main() {',
      '  int failures = 0;',
      '  auto expect = [&](bool c, const std::string& m) {',
      '    if (!c) { std::cerr << "FAIL: " << m << std::endl; failures++; }',
      '  };',
      '',
      '  const MessageInfo* info = getMessageInfo("acme.Event");',
      '  expect(info != nullptr, "Event registered");',
      '  expect(getMessageInfo("google.protobuf.Timestamp") != nullptr, "Timestamp registered");',
      '  expect(getMessageInfo("google.protobuf.Duration") != nullptr, "Duration registered");',
      '  expect(getMessageInfo("google.protobuf.FieldMask") != nullptr, "FieldMask registered");',
      '  if (info == nullptr) return 1;',
      '',
      '  auto message = AnyMap::make();',
      '  message->setString("id", "evt-1");',
      '',
      '  // created_at: Timestamp { seconds, nanos } (64-bit seconds -> string).',
      '  AnyObject ts;',
      '  ts["seconds"] = AnyValue(std::string("1700000000"));',
      '  ts["nanos"] = AnyValue(123000000.0);',
      '  message->setObject("created_at", ts);',
      '',
      '  // ttl: Duration { seconds, nanos }.',
      '  AnyObject dur;',
      '  dur["seconds"] = AnyValue(std::string("90"));',
      '  dur["nanos"] = AnyValue(500000000.0);',
      '  message->setObject("ttl", dur);',
      '',
      '  // mask: FieldMask { repeated string paths }.',
      '  AnyObject mask;',
      '  AnyArray paths;',
      '  paths.emplace_back(AnyValue(std::string("id")));',
      '  paths.emplace_back(AnyValue(std::string("created_at")));',
      '  mask["paths"] = AnyValue(paths);',
      '  message->setObject("mask", mask);',
      '',
      '  // checkpoints: repeated Timestamp.',
      '  AnyArray checkpoints;',
      '  AnyObject c0;',
      '  c0["seconds"] = AnyValue(std::string("1"));',
      '  c0["nanos"] = AnyValue(0.0);',
      '  checkpoints.emplace_back(AnyValue(c0));',
      '  AnyObject c1;',
      '  c1["seconds"] = AnyValue(std::string("2"));',
      '  c1["nanos"] = AnyValue(0.0);',
      '  checkpoints.emplace_back(AnyValue(c1));',
      '  message->setArray("checkpoints", checkpoints);',
      '',
      '  auto buffer = encodeMessage(*info, message);',
      '  auto decoded = decodeMessage(*info, buffer);',
      '',
      '  expect(decoded->getString("id") == "evt-1", "id round-trip");',
      '',
      '  auto outTs = decoded->getObject("created_at");',
      '  expect(std::get<std::string>(outTs.at("seconds")) == "1700000000", "ts.seconds");',
      '  expect(std::get<double>(outTs.at("nanos")) == 123000000.0, "ts.nanos");',
      '',
      '  auto outDur = decoded->getObject("ttl");',
      '  expect(std::get<std::string>(outDur.at("seconds")) == "90", "dur.seconds");',
      '  expect(std::get<double>(outDur.at("nanos")) == 500000000.0, "dur.nanos");',
      '',
      '  auto outMask = decoded->getObject("mask");',
      '  auto outPaths = std::get<AnyArray>(outMask.at("paths"));',
      '  expect(outPaths.size() == 2, "mask.paths length");',
      '  if (outPaths.size() == 2) {',
      '    expect(std::get<std::string>(outPaths[0]) == "id", "mask.paths[0]");',
      '    expect(std::get<std::string>(outPaths[1]) == "created_at", "mask.paths[1]");',
      '  }',
      '',
      '  auto outCheckpoints = decoded->getArray("checkpoints");',
      '  expect(outCheckpoints.size() == 2, "checkpoints length");',
      '  if (outCheckpoints.size() == 2) {',
      '    auto cp0 = std::get<AnyObject>(outCheckpoints[0]);',
      '    expect(std::get<std::string>(cp0.at("seconds")) == "1", "checkpoints[0].seconds");',
      '    auto cp1 = std::get<AnyObject>(outCheckpoints[1]);',
      '    expect(std::get<std::string>(cp1.at("seconds")) == "2", "checkpoints[1].seconds");',
      '  }',
      '',
      '  if (failures > 0) {',
      '    std::cerr << failures << " failure(s)" << std::endl;',
      '    return 1;',
      '  }',
      '  return 0;',
      '}',
    ].join('\n'),
    'utf8'
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
    ...collectPbSources(outDir),
  ]

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
    path.join(outDir, 'google', 'protobuf'),
  ]

  const binary = path.join(tmp, 'wkt')
  const compileArgs = [
    '-std=c++20',
    ...includes.flatMap((dir) => ['-I', dir]),
    ...sources,
    '-o',
    binary,
  ]

  const compile = run(compiler, compileArgs, { cwd: tmp })
  assert.equal(compile.status, 0, compile.stderr || compile.stdout)

  const execute = run(binary, [], { cwd: tmp })
  assert.equal(execute.status, 0, execute.stderr || execute.stdout)
})

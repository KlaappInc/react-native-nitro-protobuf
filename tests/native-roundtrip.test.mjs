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
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
          .split(';')
          .filter(Boolean)
      : ['']
  for (const entry of pathEntries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, `${name}${ext}`)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function pickCompiler() {
  return findExecutable('c++') ?? findExecutable('clang++') ?? findExecutable('g++')
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

test('native round-trip encode/decode', (t) => {
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-proto-native-'))
  const protoDir = path.join(tmp, 'proto')
  const outDir = path.join(tmp, 'generated')
  fs.mkdirSync(protoDir, { recursive: true })

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
    ].join('\n'),
    'utf8'
  )

  fs.writeFileSync(
    path.join(protoDir, 'extra.proto'),
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

  const testCpp = path.join(tmp, 'roundtrip.cpp')
  fs.writeFileSync(
    testCpp,
    [
      '#include "ProtobufCodec.hpp"',
      '#include "ProtobufRegistry.hpp"',
      '#include "AnyMap.hpp"',
      '#include <cmath>',
      '#include <functional>',
      '#include <iostream>',
      '#include <string>',
      '',
      'using namespace margelo::nitro;',
      'using namespace margelo::nitro::nitroprotobuf;',
      '',
      'int main() {',
      '  int failures = 0;',
      '',
      '  auto expect = [&](bool condition, const std::string& message) {',
      '    if (!condition) {',
      '      std::cerr << "FAIL: " << message << std::endl;',
      '      failures++;',
      '    }',
      '  };',
      '',
      '  auto expectNear = [&](double value, double expected, double epsilon, const std::string& message) {',
      '    if (std::fabs(value - expected) > epsilon) {',
      '      std::cerr << "FAIL: " << message << " (" << value << " vs " << expected << ")" << std::endl;',
      '      failures++;',
      '    }',
      '  };',
      '',
      '  auto expectThrow = [&](const std::string& label, const std::string& contains, const std::function<void()>& fn) {',
      '    try {',
      '      fn();',
      '      std::cerr << "FAIL: " << label << " did not throw" << std::endl;',
      '      failures++;',
      '    } catch (const std::exception& ex) {',
      '      std::string message = ex.what();',
      '      if (message.find(contains) == std::string::npos) {',
      '        std::cerr << "FAIL: " << label << " wrong error: " << message << std::endl;',
      '        failures++;',
      '      }',
      '    }',
      '  };',
      '',
      '  const MessageInfo* info = getMessageInfo("acme.User");',
      '  expect(info != nullptr, "User message available");',
      '  if (info == nullptr) {',
      '    return 1;',
      '  }',
      '',
      '  auto message = AnyMap::make();',
      '  message->setDouble("id", 7);',
      '  message->setString("name", "Ada");',
      '  message->setBoolean("active", true);',
      '  message->setString("delta", "9007199254740993");',
      '  message->setString("big", "9007199254740993");',
      '  message->setDouble("ratio", 0.25);',
      '  message->setDouble("weight", 82.125);',
      '',
      '  AnyArray scores;',
      '  scores.emplace_back(AnyValue(10.0));',
      '  scores.emplace_back(AnyValue(20.0));',
      '  message->setArray("scores", scores);',
      '',
      '  AnyArray tags;',
      '  tags.emplace_back(AnyValue(std::string("a")));',
      '  tags.emplace_back(AnyValue(std::string("b")));',
      '  message->setArray("tags", tags);',
      '',
      '  AnyArray avatar;',
      '  avatar.emplace_back(AnyValue(1.0));',
      '  avatar.emplace_back(AnyValue(2.0));',
      '  avatar.emplace_back(AnyValue(3.0));',
      '  message->setArray("avatar", avatar);',
      '',
      '  AnyObject address;',
      '  address["street"] = AnyValue(std::string("Main St"));',
      '  address["zip"] = AnyValue(12345.0);',
      '  message->setObject("address", address);',
      '',
      '  auto buffer = encodeMessage(*info, message);',
      '  expect(encodedByteLength(*info, message) == buffer->size(), "byteLength matches encoded size");',
      '  auto decoded = decodeMessage(*info, buffer);',
      '',
      '  expect(decoded->getDouble("id") == 7, "id round-trip");',
      '  expect(decoded->getString("name") == "Ada", "name round-trip");',
      '  expect(decoded->getBoolean("active") == true, "active round-trip");',
      '  expect(decoded->getString("avatar") == "AQID", "avatar base64 round-trip");',
      '  expect(decoded->getString("delta") == "9007199254740993", "int64 round-trip as string");',
      '  expect(decoded->getString("big") == "9007199254740993", "uint64 round-trip as string");',
      '  expectNear(decoded->getDouble("ratio"), 0.25, 1e-6, "ratio round-trip");',
      '  expectNear(decoded->getDouble("weight"), 82.125, 1e-9, "weight round-trip");',
      '',
      '  auto outScores = decoded->getArray("scores");',
      '  expect(outScores.size() == 2, "scores length");',
      '  if (outScores.size() == 2) {',
      '    expect(std::get<double>(outScores[0]) == 10.0, "scores[0]");',
      '    expect(std::get<double>(outScores[1]) == 20.0, "scores[1]");',
      '  }',
      '',
      '  auto outTags = decoded->getArray("tags");',
      '  expect(outTags.size() == 2, "tags length");',
      '  if (outTags.size() == 2) {',
      '    expect(std::get<std::string>(outTags[0]) == "a", "tags[0]");',
      '    expect(std::get<std::string>(outTags[1]) == "b", "tags[1]");',
      '  }',
      '',
      '  auto outAddress = decoded->getObject("address");',
      '  expect(std::get<std::string>(outAddress.at("street")) == "Main St", "address.street");',
      '  expect(std::get<double>(outAddress.at("zip")) == 12345.0, "address.zip");',
      '',
      '  auto oversizedName = AnyMap::make();',
      '  oversizedName->setString("name", std::string(40, \'x\'));',
      '  expectThrow("max_length", "max_length", [&]() { encodeMessage(*info, oversizedName); });',
      '',
      '  auto tooManyScores = AnyMap::make();',
      '  AnyArray manyScores;',
      '  for (int i = 0; i < 9; i++) {',
      '    manyScores.emplace_back(AnyValue(static_cast<double>(i)));',
      '  }',
      '  tooManyScores->setArray("scores", manyScores);',
      '  expectThrow("max_count", "max_count", [&]() { encodeMessage(*info, tooManyScores); });',
      '',
      '  auto tooManyBytes = AnyMap::make();',
      '  AnyArray bytes;',
      '  for (int i = 0; i < 40; i++) {',
      '    bytes.emplace_back(AnyValue(1.0));',
      '  }',
      '  tooManyBytes->setArray("avatar", bytes);',
      '  expectThrow("max_size", "max_size", [&]() { encodeMessage(*info, tooManyBytes); });',
      '',
      '  auto unknownField = AnyMap::make();',
      '  unknownField->setDouble("unknown", 1.0);',
      '  expectThrow("unknown field", "Unknown field", [&]() { encodeMessage(*info, unknownField); });',
      '',
      '  const MessageInfo* configInfo = getMessageInfo("acme.Config");',
      '  expect(configInfo != nullptr, "Config message available");',
      '  if (configInfo != nullptr) {',
      '    auto mapField = AnyMap::make();',
      '    AnyObject labels;',
      '    labels["key"] = AnyValue(1.0);',
      '    mapField->setObject("labels", labels);',
      '    expectThrow("map field", "Map fields are not supported", [&]() { encodeMessage(*configInfo, mapField); });',
      '',
      '    auto oneofField = AnyMap::make();',
      '    oneofField->setString("name", "Bob");',
      '    expectThrow("oneof field", "oneof fields are not supported", [&]() { encodeMessage(*configInfo, oneofField); });',
      '  }',
      '',
      '  if (failures > 0) {',
      '    std::cerr << failures << " failure(s)" << std::endl;',
      '    return 1;',
      '  }',
      '',
      '  return 0;',
      '}',
    ].join('\n'),
    'utf8'
  )

  const pbSources = fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith('.pb.c'))
    .map((name) => path.join(outDir, name))

  const sources = [
    testCpp,
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

  // `NitroModules/` shim so the codec's `<NitroModules/...>` includes resolve in
  // a raw host compile (package ships the flat cpp/core layout; the prefixed
  // form is provided by iOS pods / Android prefab at build time).
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

  const binary = path.join(tmp, 'roundtrip')
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

// Compile (clang++ -O2, no sanitizers) and run bench/native-bench.cpp, then
// print + persist the JSON results. Mirrors the source/include recipe used by
// tests/native-fuzz.test.mjs, plus a `NitroModules/` shim include dir so the
// codec's `<NitroModules/...>` includes resolve in a raw host compile, and the
// allocation-counting bench links its own global operator new/delete.
//
// Usage: node bench/run-native.mjs   (needs protoc + protoc-gen-nanopb + clang++)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const benchSrc = path.join(__dirname, 'native-bench.cpp')
const generatorPath = path.join(repoRoot, 'scripts', 'generate-protos.mjs')

function findExecutable(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const c = path.join(dir, name)
    if (fs.existsSync(c)) return c
  }
  return null
}
const pickCompiler = () =>
  findExecutable('clang++') ?? findExecutable('c++') ?? findExecutable('g++')
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', ...opts })

const protoc = process.env.PROTOC ?? findExecutable('protoc')
const nanopb =
  process.env.NANOPB_PLUGIN ??
  process.env.NANOPB_PROTOC_GEN ??
  findExecutable('protoc-gen-nanopb')
const compiler = pickCompiler()
if (!protoc) throw new Error('protoc not found (brew install protobuf)')
if (!nanopb) throw new Error('protoc-gen-nanopb not found (pip install nanopb)')
if (!compiler) throw new Error('no C++ compiler found')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-bench-'))
const outDir = path.join(tmp, 'generated')

// Assemble a proto dir: the example protos (acme.User et al.) plus the larger
// acme.Blob used by the size sweep (bench/proto/blob.{proto,options}).
const protoDir = path.join(tmp, 'proto')
fs.mkdirSync(protoDir, { recursive: true })
for (const dir of [
  path.join(repoRoot, 'example', 'proto'),
  path.join(__dirname, 'proto'),
]) {
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.proto') || f.endsWith('.options')) {
      fs.copyFileSync(path.join(dir, f), path.join(protoDir, f))
    }
  }
}

// Generate acme protos fresh (self-contained, independent of repo generated/).
const gen = run(process.execPath, [
  generatorPath,
  '--protoDir',
  protoDir,
  '--outDir',
  outDir,
  '--protoc',
  protoc,
  '--nanopb',
  nanopb,
])
if (gen.status !== 0)
  throw new Error(`generate failed:\n${gen.stderr || gen.stdout}`)

// `NitroModules/` shim so `<NitroModules/ArrayBuffer.hpp>` resolves on host.
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

const nm = path.join(
  repoRoot,
  'node_modules',
  'react-native-nitro-modules',
  'cpp'
)
const rn = path.join(
  repoRoot,
  'node_modules',
  'react-native',
  'ReactCommon',
  'jsi'
)
const pbSources = fs
  .readdirSync(outDir)
  .filter((n) => n.endsWith('.pb.c'))
  .map((n) => path.join(outDir, n))

const sources = [
  benchSrc,
  path.join(repoRoot, 'cpp', 'ProtobufCodec.cpp'),
  path.join(repoRoot, 'cpp', 'Base64.cpp'),
  path.join(nm, 'core', 'AnyMap.cpp'),
  path.join(nm, 'core', 'ArrayBuffer.cpp'),
  path.join(rn, 'jsi', 'jsi.cpp'),
  path.join(rn, 'jsi', 'jsilib-posix.cpp'),
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
  path.join(nm, 'core'),
  path.join(nm, 'utils'),
  rn,
  outDir,
]

const binary = path.join(tmp, 'bench')
console.error(`Compiling native bench with ${path.basename(compiler)} -O2 ...`)
const compile = run(compiler, [
  '-std=c++20',
  '-O2',
  '-DNDEBUG',
  ...includes.flatMap((d) => ['-I', d]),
  ...sources,
  '-o',
  binary,
])
if (compile.status !== 0)
  throw new Error(`compile failed:\n${compile.stderr || compile.stdout}`)

console.error('Running native bench (warmup + 7 trials/profile) ...')
const exec = run(binary, [], { maxBuffer: 64 * 1024 * 1024 })
if (exec.status !== 0)
  throw new Error(`bench failed:\n${exec.stderr || exec.stdout}`)

const results = JSON.parse(exec.stdout)
const outFile = path.join(__dirname, 'results-native.json')
fs.writeFileSync(outFile, JSON.stringify(results, null, 2))

// Pretty table to stderr; raw JSON already saved.
const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)
console.error(
  '\nprofile     bytes   enc ns/op   enc ops/s   enc p99   dec ns/op   dec ops/s   dec p99  alloc(e/d)'
)
for (const r of results) {
  console.error(
    `${pad(r.profile, 10)} ${padL(r.bytes, 5)} ${padL(r.encode.nsop.toFixed(0), 9)} ${padL((r.encode.opsps / 1e6).toFixed(2) + 'M', 11)} ${padL(r.encode.p99.toFixed(0), 8)} ${padL(r.decode.nsop.toFixed(0), 10)} ${padL((r.decode.opsps / 1e6).toFixed(2) + 'M', 11)} ${padL(r.decode.p99.toFixed(0), 8)}   ${r.encode.allocs}/${r.decode.allocs}`
  )
}
console.error(`\nSaved ${outFile}`)

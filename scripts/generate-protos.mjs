#!/usr/bin/env node
import { execFileSync } from 'child_process'
import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'
import protobuf from 'protobufjs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const moduleRoot = path.resolve(__dirname, '..')

// nanopb generator must match the vendored runtime in cpp/nanopb.
const NANOPB_VERSION = '0.4.9.1'

function findExecutable(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

function venvBinDir(venv) {
  return path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin')
}

// protoc: explicit flag/env -> grpc-tools bundle -> system protoc.
function resolveProtoc(args) {
  if (args.protoc) return args.protoc
  if (process.env.PROTOC) return process.env.PROTOC
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('grpc-tools/package.json')
    const bin = path.join(
      path.dirname(pkg),
      'bin',
      process.platform === 'win32' ? 'protoc.exe' : 'protoc'
    )
    if (fs.existsSync(bin)) return bin
  } catch {
    // grpc-tools not installed; fall through to system protoc.
  }
  const system = findExecutable('protoc')
  if (system) return system
  throw new Error(
    'protoc not found. Reinstall dependencies (grpc-tools provides a bundled ' +
      'protoc) or pass --protoc <path>.'
  )
}

// nanopb plugin: explicit flag/env -> cached venv -> bootstrap (python3 + pip).
function resolveNanopbPlugin(args) {
  if (args.nanopb) return args.nanopb
  if (process.env.NANOPB_PLUGIN) return process.env.NANOPB_PLUGIN
  if (process.env.NANOPB_PROTOC_GEN) return process.env.NANOPB_PROTOC_GEN

  const cacheDir = path.join(moduleRoot, '.cache')
  const venv = path.join(cacheDir, 'nanopb-venv')
  const pluginName = process.platform === 'win32' ? 'protoc-gen-nanopb.exe' : 'protoc-gen-nanopb'
  const plugin = path.join(venvBinDir(venv), pluginName)
  if (fs.existsSync(plugin)) return plugin

  const python = findExecutable('python3') ?? findExecutable('python')
  if (!python) {
    throw new Error(
      'The nanopb code generator is missing and python3 (needed once to install ' +
        'it) was not found. Install python3, or install nanopb yourself and pass ' +
        '--nanopb <path to protoc-gen-nanopb>.'
    )
  }

  console.error(`[nitro-protobuf] Installing nanopb ${NANOPB_VERSION} generator (one-time setup)…`)
  fs.mkdirSync(cacheDir, { recursive: true })
  execFileSync(python, ['-m', 'venv', venv], { stdio: 'inherit' })
  const pip = path.join(venvBinDir(venv), process.platform === 'win32' ? 'pip.exe' : 'pip')
  execFileSync(pip, ['install', '--quiet', `nanopb==${NANOPB_VERSION}`], { stdio: 'inherit' })
  if (!fs.existsSync(plugin)) {
    throw new Error('nanopb bootstrap failed: protoc-gen-nanopb not found after install.')
  }
  return plugin
}

function usage() {
  return [
    'Usage: react-native-nitro-protobuf <command> [options]',
    '',
    'Commands:',
    '  init                   Scaffold proto/, config, and a generate script',
    '  generate               Generate nanopb sources, registry, and TS types (default)',
    '',
    'Options:',
    '  --protoDir <path>      Directory containing .proto files (default: ./proto)',
    '  --outDir <path>        Output directory for generated C/registry (default: <module>/generated)',
    '  --tsOut <path>         Output directory for generated TS types (default: outDir)',
    '  --protoPath <path>     Extra import paths for protoc (repeatable)',
    '  --protoc <path>        Path to protoc binary (default: bundled grpc-tools)',
    '  --nanopb <path>        Path to protoc-gen-nanopb (default: auto-installed)',
    '  --strict               Require explicit .options for every static field',
    '  --skipProtoc           Skip protoc invocation (registry only)',
    '  --help                 Show help',
    '',
    'Field size limits default to 256/256/16 (max_length/max_size/max_count).',
    'Override globally in nitro-protobuf.config.json or per-field in *.options.',
  ].join('\n')
}

function parseArgs(argv) {
  const args = { _: [], protoPath: [], skipProtoc: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--protoDir') {
      args.protoDir = argv[++i]
    } else if (arg === '--outDir') {
      args.outDir = argv[++i]
    } else if (arg === '--tsOut') {
      args.tsOut = argv[++i]
    } else if (arg === '--protoPath') {
      args.protoPath.push(argv[++i])
    } else if (arg === '--protoc') {
      args.protoc = argv[++i]
    } else if (arg === '--nanopb' || arg === '--nanopbPlugin') {
      args.nanopb = argv[++i]
    } else if (arg === '--skipProtoc' || arg === '--skip-protoc') {
      args.skipProtoc = true
    } else if (arg === '--strict') {
      args.strict = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      args._.push(arg)
    }
  }
  return args
}

function collectProtoFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectProtoFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.proto')) {
      files.push(fullPath)
    }
  }
  return files
}

function cppString(value) {
  // Escape backslashes first, then double quotes, for a C++ string literal.
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function mapFieldType(field) {
  if (field.resolvedType instanceof protobuf.Type) return 'Message'
  if (field.resolvedType instanceof protobuf.Enum) return 'Enum'
  switch (field.type) {
    case 'bool':
      return 'Bool'
    case 'int32':
      return 'Int32'
    case 'int64':
      return 'Int64'
    case 'uint32':
      return 'UInt32'
    case 'uint64':
      return 'UInt64'
    case 'sint32':
      return 'SInt32'
    case 'sint64':
      return 'SInt64'
    case 'fixed32':
      return 'Fixed32'
    case 'fixed64':
      return 'Fixed64'
    case 'sfixed32':
      return 'SFixed32'
    case 'sfixed64':
      return 'SFixed64'
    case 'float':
      return 'Float'
    case 'double':
      return 'Double'
    case 'string':
      return 'String'
    case 'bytes':
      return 'Bytes'
    default:
      throw new Error(`Unsupported field type: ${field.type}`)
  }
}

// Parse all *.options files in the given dirs into a Map of
// target-pattern -> Set(optionKeys present). nanopb targets may use `*` globs.
function loadOptionsKeys(dirs) {
  const map = new Map()
  const seen = new Set()
  for (const dir of dirs) {
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.options')) continue
      const full = path.join(dir, name)
      if (seen.has(full)) continue
      seen.add(full)
      const text = fs.readFileSync(full, 'utf8')
      for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim()
        if (!line) continue
        const m = line.match(/^(\S+)\s+(.*)$/)
        if (!m) continue
        const target = m[1]
        const keys = [...m[2].matchAll(/([A-Za-z_]+)\s*:/g)].map((x) => x[1])
        if (!map.has(target)) map.set(target, new Set())
        for (const k of keys) map.get(target).add(k)
      }
    }
  }
  return map
}

function optionPatternMatches(pattern, name) {
  const rx = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$'
  )
  return rx.test(name)
}

function fieldHasOption(optsMap, fullField, key) {
  for (const [pattern, keys] of optsMap) {
    if (keys.has(key) && optionPatternMatches(pattern, fullField)) return true
  }
  return false
}

// Hard-fail if any codec-supported static field is missing the nanopb option
// that keeps it a static (non-callback) field. oneof/map fields are skipped:
// the codec rejects them at runtime regardless, so they never become static.
function validateOptions(messages, optsMap) {
  const problems = []
  for (const message of messages) {
    const fullName = message.fullName.startsWith('.')
      ? message.fullName.slice(1)
      : message.fullName
    for (const field of message.fieldsArray) {
      if (field.partOf || field.map) continue
      const ff = `${fullName}.${field.name}`
      if (field.repeated && !fieldHasOption(optsMap, ff, 'max_count')) {
        problems.push(`${ff} (repeated) needs 'max_count'`)
      }
      if (field.type === 'string' && !fieldHasOption(optsMap, ff, 'max_length')) {
        problems.push(`${ff} (string) needs 'max_length'`)
      }
      if (field.type === 'bytes' && !fieldHasOption(optsMap, ff, 'max_size')) {
        problems.push(`${ff} (bytes) needs 'max_size'`)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      'Missing required nanopb .options for static fields (else nanopb emits ' +
        'callback fields the codec cannot handle at runtime):\n  - ' +
        problems.join('\n  - ') +
        '\nAdd them to a .options file beside your .proto, e.g.\n' +
        '  acme.User.name max_length: 64'
    )
  }
}

// Built-in default field limits (override via config / inline .options).
const DEFAULT_LIMITS = { maxLength: 256, maxSize: 256, maxCount: 16 }

// Load nitro-protobuf.config.json (or a `nitroProtobuf` key in package.json)
// from the working directory. All fields optional.
function loadConfig(cwd) {
  const jsonPath = path.join(cwd, 'nitro-protobuf.config.json')
  if (fs.existsSync(jsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    } catch (e) {
      throw new Error(`Invalid nitro-protobuf.config.json: ${e.message}`)
    }
  }
  const pkgPath = path.join(cwd, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).nitroProtobuf ?? {}
    } catch {
      return {}
    }
  }
  return {}
}

// nanopb reads the FIRST `<proto>.options` found in ['.'] + options_path. We
// synthesize, in a temp dir searched first, a merged file per proto:
// wildcard defaults (so every static field is sized without hand-written
// options) followed by the user's own .options (specific entries override the
// `*` defaults). Returns the temp dir to pass via `--nanopb_opt=-I`.
function writeMergedOptions(protoFiles, includeDirs, defaults, outDir) {
  const tempDir = path.join(outDir, '.nanopb-options')
  fs.rmSync(tempDir, { recursive: true, force: true })
  fs.mkdirSync(tempDir, { recursive: true })
  const header =
    `# Auto-generated defaults (nitro-protobuf). Specific entries below win.\n` +
    `* max_length: ${defaults.maxLength}\n` +
    `* max_size: ${defaults.maxSize}\n` +
    `* max_count: ${defaults.maxCount}\n`
  for (const proto of protoFiles) {
    const base = path.basename(proto, '.proto')
    let userOptions = ''
    for (const dir of includeDirs) {
      const candidate = path.join(dir, `${base}.options`)
      if (fs.existsSync(candidate)) {
        userOptions = fs.readFileSync(candidate, 'utf8')
        break
      }
    }
    fs.writeFileSync(
      path.join(tempDir, `${base}.options`),
      header + (userOptions ? `\n# User overrides (${base}.options)\n${userOptions}` : '')
    )
  }
  return tempDir
}

// "acme.User" -> "AcmeUser"; "acme.Foo.Bar" -> "AcmeFooBar".
function tsTypeName(fullName) {
  const clean = fullName.startsWith('.') ? fullName.slice(1) : fullName
  return clean
    .split(/[._]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')
}

// Map a proto field to the codec's JS representation.
function tsFieldType(field) {
  let base
  if (field.resolvedType instanceof protobuf.Type) {
    base = tsTypeName(field.resolvedType.fullName)
  } else if (field.resolvedType instanceof protobuf.Enum) {
    base = 'number'
  } else {
    switch (field.type) {
      case 'bool':
        base = 'boolean'
        break
      case 'int64':
      case 'uint64':
      case 'sint64':
      case 'fixed64':
      case 'sfixed64':
        base = 'string' // 64-bit -> decimal string (precision-safe)
        break
      case 'string':
        base = 'string'
        break
      case 'bytes':
        base = 'string | number[]' // base64 string or byte array
        break
      default:
        base = 'number'
    }
  }
  return field.repeated ? `(${base})[]` : base
}

// Per-message TS interfaces (codec JS shapes) + a typed encode/decode facade.
function generateTypes(messages) {
  const out = ['// Auto-generated by react-native-nitro-protobuf. Do not edit.']
  out.push("import { NitroProtobuf } from 'react-native-nitro-protobuf'", '')
  for (const m of messages) {
    out.push(`export interface ${tsTypeName(m.fullName)} {`)
    for (const f of m.fieldsArray) {
      out.push(`  ${f.name}?: ${tsFieldType(f)}`)
    }
    out.push('}', '')
  }
  out.push('export interface NitroProtobufMessages {')
  for (const m of messages) {
    const full = m.fullName.startsWith('.') ? m.fullName.slice(1) : m.fullName
    out.push(`  '${full}': ${tsTypeName(m.fullName)}`)
  }
  out.push('}', '')
  out.push(
    'export type NitroProtobufMessageName = keyof NitroProtobufMessages',
    '',
    'export function encode<K extends NitroProtobufMessageName>(',
    '  name: K,',
    '  message: NitroProtobufMessages[K]',
    '): ArrayBuffer {',
    '  return NitroProtobuf.encode(name, message as never)',
    '}',
    '',
    'export function decode<K extends NitroProtobufMessageName>(',
    '  name: K,',
    '  data: ArrayBuffer',
    '): NitroProtobufMessages[K] {',
    '  return NitroProtobuf.decode(name, data) as NitroProtobufMessages[K]',
    '}',
    ''
  )
  return out.join('\n')
}

// Scaffold a new project: proto dir + sample .proto, config, and a
// proto:generate script in package.json.
function runInit(cwd) {
  const protoDir = path.join(cwd, 'proto')
  fs.mkdirSync(protoDir, { recursive: true })

  const sampleProto = path.join(protoDir, 'sample.proto')
  if (!fs.existsSync(sampleProto)) {
    fs.writeFileSync(
      sampleProto,
      [
        'syntax = "proto3";',
        'package app;',
        '',
        'message Profile {',
        '  uint32 id = 1;',
        '  string name = 2;',
        '  repeated string tags = 3;',
        '  bool active = 4;',
        '}',
        '',
      ].join('\n')
    )
    console.log('Created proto/sample.proto')
  }

  const configPath = path.join(cwd, 'nitro-protobuf.config.json')
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        { protoDir: 'proto', defaults: DEFAULT_LIMITS },
        null,
        2
      ) + '\n'
    )
    console.log('Created nitro-protobuf.config.json')
  }

  const pkgPath = path.join(cwd, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    pkg.scripts = pkg.scripts ?? {}
    if (!pkg.scripts['proto:generate']) {
      pkg.scripts['proto:generate'] = 'react-native-nitro-protobuf generate'
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
      console.log('Added "proto:generate" script to package.json')
    }
  }

  console.log(
    '\nDone. Next:\n' +
      '  1. Edit proto/*.proto (limits default to 256/256/16; override in\n' +
      '     nitro-protobuf.config.json or per-field .options).\n' +
      '  2. Run: npm run proto:generate\n' +
      '  3. Rebuild your app (cd ios && pod install).\n' +
      "  4. import { encode, decode } from the generated 'nitro-protobuf' types.\n"
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  if (args._[0] === 'init') {
    runInit(process.cwd())
    return
  }

  if (args._[0] === 'generate') {
    args._.shift()
  }

  const cwd = process.cwd()
  const config = loadConfig(cwd)
  const protoDir = path.resolve(cwd, args.protoDir ?? config.protoDir ?? 'proto')
  const outDir = path.resolve(
    cwd,
    args.outDir ?? config.outDir ?? path.join(moduleRoot, 'generated')
  )
  const defaults = { ...DEFAULT_LIMITS, ...(config.defaults ?? {}) }
  const strict = args.strict ?? config.strict ?? false
  const includeDirs = [
    protoDir,
    ...(args.protoPath ?? []).map((dir) => path.resolve(cwd, dir)),
  ]
  if (!fs.existsSync(protoDir)) {
    throw new Error(`Proto directory not found: ${protoDir}`)
  }

  const protoFiles = collectProtoFiles(protoDir).sort()
  if (protoFiles.length === 0) {
    throw new Error(`No .proto files found in ${protoDir}`)
  }

  fs.mkdirSync(outDir, { recursive: true })

  if (!args.skipProtoc) {
    const protoc = resolveProtoc(args)
    const nanopbPlugin = resolveNanopbPlugin(args)

    const protocArgs = []
    includeDirs.forEach((dir) => protocArgs.push(`--proto_path=${dir}`))
    // In the default (non-strict) mode, synthesize wildcard default limits so
    // every static field is sized without hand-written .options. Searched first.
    if (!strict) {
      const optsDir = writeMergedOptions(protoFiles, includeDirs, defaults, outDir)
      protocArgs.push(`--nanopb_opt=-I${optsDir}`)
    }
    includeDirs.forEach((dir) => protocArgs.push(`--nanopb_opt=-I${dir}`))
    protocArgs.push(`--plugin=protoc-gen-nanopb=${nanopbPlugin}`)
    protocArgs.push(`--nanopb_out=${outDir}`)
    protocArgs.push(...protoFiles)

    execFileSync(protoc, protocArgs, { stdio: 'inherit' })
  }

  const root = new protobuf.Root()
  root.resolvePath = (origin, target) => {
    if (path.isAbsolute(target)) return target
    const originDir = origin && origin !== 'protobufjs' ? path.dirname(origin) : null
    const candidates = []
    if (originDir) candidates.push(path.join(originDir, target))
    includeDirs.forEach((dir) => candidates.push(path.join(dir, target)))
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
    return originDir ? path.join(originDir, target) : target
  }

  await root.load(protoFiles, { keepCase: true })
  root.resolveAll()

  const messages = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.pop()
    if (!current || !current.nestedArray) continue
    for (const nested of current.nestedArray) {
      if (nested instanceof protobuf.Type) {
        if (!nested.options?.map_entry) {
          messages.push(nested)
        }
      }
      if (nested.nestedArray) {
        queue.push(nested)
      }
    }
  }

  messages.sort((a, b) => a.fullName.localeCompare(b.fullName))

  // Validate nanopb .options for static fields. Skipped with --skipProtoc,
  // which only emits the registry (no nanopb compilation) — used by unit tests.
  // In --strict mode, require explicit options for every static field (no
  // defaults injected). Otherwise the synthesized wildcard defaults cover them.
  if (!args.skipProtoc && strict) {
    validateOptions(messages, loadOptionsKeys(includeDirs))
  }

  const headerIncludes = new Set(
    protoFiles.map((file) => `${path.basename(file, '.proto')}.pb.h`)
  )

  const lines = []
  lines.push('// This file is auto-generated. Do not edit.')
  lines.push('#include "../cpp/ProtobufRegistry.hpp"')
  headerIncludes.forEach((header) => {
    lines.push(`#include "${header}"`)
  })
  lines.push('')
  lines.push('namespace margelo::nitro::nitroprotobuf {')
  lines.push('')

  const messageEntries = []
  for (const message of messages) {
    const fullName = message.fullName.startsWith('.')
      ? message.fullName.slice(1)
      : message.fullName
    const parts = fullName.split('.')
    const baseName = parts.join('_')
    const cBase = baseName
    const cType = cBase
    const cMsg = `${cBase}_msg`
    const cInitDefault = `${cBase}_init_default`
    const initFn = `init_default_${cBase}`
    const fieldsVar = `k_${cBase}_fields`

    lines.push(`static void ${initFn}(void* message) {`)
    lines.push(`  *static_cast<${cType}*>(message) = ${cInitDefault};`)
    lines.push('}')
    lines.push('')

    lines.push(`static const FieldInfo ${fieldsVar}[] = {`)
    for (const field of message.fieldsArray) {
      const fieldType = mapFieldType(field)
      const typeName =
        fieldType === 'Message' || fieldType === 'Enum'
          ? field.resolvedType?.fullName?.replace(/^\./, '') ?? ''
          : ''
      const typeNameLiteral = typeName ? `"${cppString(typeName)}"` : 'nullptr'
      const isOneof = Boolean(field.partOf)
      const isMap = Boolean(field.map)
      lines.push(
        `  {"${cppString(field.name)}", ${field.id}, FieldType::${fieldType}, ` +
          `${field.repeated ? 'true' : 'false'}, ${isOneof ? 'true' : 'false'}, ` +
          `${isMap ? 'true' : 'false'}, ${typeNameLiteral}},`
      )
    }
    lines.push('};')
    lines.push('')

    messageEntries.push({
      name: fullName,
      descriptor: cMsg,
      structType: cType,
      fieldsVar,
      initFn,
    })
  }

  lines.push('static const MessageInfo kMessages[] = {')
  for (const entry of messageEntries) {
    lines.push(
      `  {"${cppString(entry.name)}", &${entry.descriptor}, sizeof(${entry.structType}), ` +
        `${entry.fieldsVar}, sizeof(${entry.fieldsVar}) / sizeof(${entry.fieldsVar}[0]), ${entry.initFn}},`
    )
  }
  lines.push('};')
  lines.push('')

  lines.push('const MessageInfo* getMessageInfo(const std::string& name) {')
  lines.push('  for (const auto& message : kMessages) {')
  lines.push('    if (name == message.name) {')
  lines.push('      return &message;')
  lines.push('    }')
  lines.push('  }')
  lines.push('  return nullptr;')
  lines.push('}')
  lines.push('')

  lines.push('const MessageInfo* getMessageInfo(const pb_msgdesc_s* descriptor) {')
  lines.push('  for (const auto& message : kMessages) {')
  lines.push('    if (descriptor == message.descriptor) {')
  lines.push('      return &message;')
  lines.push('    }')
  lines.push('  }')
  lines.push('  return nullptr;')
  lines.push('}')
  lines.push('')

  lines.push('std::vector<std::string> getMessageNames() {')
  lines.push('  std::vector<std::string> names;')
  lines.push('  names.reserve(sizeof(kMessages) / sizeof(kMessages[0]));')
  lines.push('  for (const auto& message : kMessages) {')
  lines.push('    names.emplace_back(message.name);')
  lines.push('  }')
  lines.push('  return names;')
  lines.push('}')
  lines.push('')

  lines.push('const FieldInfo* findFieldByName(const MessageInfo& message, const std::string& name) {')
  lines.push('  for (size_t i = 0; i < message.field_count; i++) {')
  lines.push('    const FieldInfo& field = message.fields[i];')
  lines.push('    if (name == field.name) {')
  lines.push('      return &field;')
  lines.push('    }')
  lines.push('  }')
  lines.push('  return nullptr;')
  lines.push('}')
  lines.push('')
  lines.push('} // namespace margelo::nitro::nitroprotobuf')
  lines.push('')

  const registryPath = path.join(outDir, 'nitro_protobuf_registry.cpp')
  fs.writeFileSync(registryPath, lines.join('\n'))
  console.log(`Generated registry at ${registryPath}`)

  // Typed interfaces + encode/decode facade for type-safe usage.
  const tsOut = path.resolve(cwd, args.tsOut ?? config.tsOut ?? outDir)
  fs.mkdirSync(tsOut, { recursive: true })
  const typesPath = path.join(tsOut, 'nitro-protobuf.ts')
  fs.writeFileSync(typesPath, generateTypes(messages))
  console.log(`Generated types at ${typesPath}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

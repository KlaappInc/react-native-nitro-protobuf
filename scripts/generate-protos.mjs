#!/usr/bin/env node
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import protobuf from 'protobufjs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const moduleRoot = path.resolve(__dirname, '..')

function usage() {
  return [
    'Usage: react-native-nitro-protobuf [generate] [options]',
    '',
    'Options:',
    '  --protoDir <path>      Directory containing .proto files (default: ./proto)',
    '  --outDir <path>        Output directory for generated files (default: <module>/generated)',
    '  --protoPath <path>     Extra import paths for protoc (repeatable)',
    '  --protoc <path>        Path to protoc binary (default: protoc)',
    '  --nanopb <path>        Path to protoc-gen-nanopb plugin (optional)',
    '  --skipProtoc           Skip protoc invocation (registry only)',
    '  --help                 Show help',
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
    } else if (arg === '--protoPath') {
      args.protoPath.push(argv[++i])
    } else if (arg === '--protoc') {
      args.protoc = argv[++i]
    } else if (arg === '--nanopb' || arg === '--nanopbPlugin') {
      args.nanopb = argv[++i]
    } else if (arg === '--skipProtoc' || arg === '--skip-protoc') {
      args.skipProtoc = true
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  if (args._[0] === 'generate') {
    args._.shift()
  }

  const cwd = process.cwd()
  const protoDir = path.resolve(cwd, args.protoDir ?? 'proto')
  const outDir = path.resolve(cwd, args.outDir ?? path.join(moduleRoot, 'generated'))
  const includeDirs = [
    protoDir,
    ...(args.protoPath ?? []).map((dir) => path.resolve(cwd, dir)),
  ]
  const protoc = args.protoc ?? process.env.PROTOC ?? 'protoc'
  const nanopbPlugin =
    args.nanopb ??
    process.env.NANOPB_PLUGIN ??
    process.env.NANOPB_PROTOC_GEN ??
    null

  if (!fs.existsSync(protoDir)) {
    throw new Error(`Proto directory not found: ${protoDir}`)
  }

  const protoFiles = collectProtoFiles(protoDir).sort()
  if (protoFiles.length === 0) {
    throw new Error(`No .proto files found in ${protoDir}`)
  }

  fs.mkdirSync(outDir, { recursive: true })

  if (!args.skipProtoc) {
    try {
      execFileSync(protoc, ['--version'], { stdio: 'ignore' })
    } catch (error) {
      throw new Error(`protoc not found. Install protoc or pass --protoc <path>.`)
    }

    const protocArgs = []
    includeDirs.forEach((dir) => protocArgs.push(`--proto_path=${dir}`))
    includeDirs.forEach((dir) => protocArgs.push(`--nanopb_opt=-I${dir}`))
    if (nanopbPlugin) {
      protocArgs.push(`--plugin=protoc-gen-nanopb=${nanopbPlugin}`)
    }
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
  if (!args.skipProtoc) {
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

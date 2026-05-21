// Optional Metro integration: regenerate protobuf code whenever Metro starts,
// so a fresh `metro start` always has up-to-date types without a separate step.
// For live regeneration while editing, run `proto:generate --watch` alongside.
//
//   // metro.config.js
//   const { getDefaultConfig } = require('@react-native/metro-config')
//   const { withNitroProtobuf } = require('@klaappinc/react-native-nitro-protobuf/metro')
//   module.exports = withNitroProtobuf(getDefaultConfig(__dirname), { protoDir: 'proto' })
//
// Codegen failures are reported as a warning and never crash Metro (the config
// is returned unchanged), so a transient schema error doesn't block the bundler.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/**
 * @param {object} config  A Metro config object.
 * @param {object} [options]
 * @param {string} [options.protoDir='proto']
 * @param {string} [options.outDir]
 * @param {string} [options.tsOut]
 * @param {boolean} [options.bigint]
 * @param {'string'|'number'} [options.enums]
 * @param {boolean} [options.skipProtoc]  Regenerate TS types + registry only.
 * @param {string} [options.cwd=process.cwd()]
 * @returns the same config (unchanged), after running codegen once.
 */
function withNitroProtobuf(config, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const protoDir = options.protoDir ?? 'proto'

  if (!fs.existsSync(path.resolve(cwd, protoDir))) {
    console.warn(
      `[nitro-protobuf] metro: proto dir "${protoDir}" not found; skipping codegen.`
    )
    return config
  }

  const args = ['generate', '--protoDir', protoDir]
  if (options.outDir) args.push('--outDir', options.outDir)
  if (options.tsOut) args.push('--tsOut', options.tsOut)
  if (options.bigint) args.push('--bigint')
  if (options.enums) args.push('--enums', options.enums)
  if (options.skipProtoc) args.push('--skipProtoc')

  try {
    execFileSync(
      process.execPath,
      [path.join(__dirname, 'scripts', 'generate-protos.mjs'), ...args],
      { cwd, stdio: 'inherit' }
    )
  } catch (e) {
    console.warn(
      '[nitro-protobuf] metro: codegen failed (continuing):',
      e instanceof Error ? e.message : String(e)
    )
  }
  return config
}

module.exports = { withNitroProtobuf }

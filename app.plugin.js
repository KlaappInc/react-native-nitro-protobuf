// Expo config plugin: regenerate protobuf sources during `expo prebuild` so
// the generated registry / nanopb C / TS types are always fresh - no manual
// `proto:generate` step for Expo apps.
//
// app.json / app.config.js:
//   { "plugins": [["@klaappinc/react-native-nitro-protobuf", { "protoDir": "proto" }]] }
const { execFileSync } = require('child_process')

function runGenerate(projectRoot, props) {
  const bin =
    require.resolve('@klaappinc/react-native-nitro-protobuf/scripts/generate-protos.mjs')
  const args = ['generate']
  if (props.protoDir) args.push('--protoDir', props.protoDir)
  if (props.outDir) args.push('--outDir', props.outDir)
  if (props.tsOut) args.push('--tsOut', props.tsOut)
  if (props.strict) args.push('--strict')
  execFileSync('node', [bin, ...args], { cwd: projectRoot, stdio: 'inherit' })
}

const withNitroProtobuf = (config, props = {}) => {
  let withDangerousMod
  try {
    ;({ withDangerousMod } = require('@expo/config-plugins'))
  } catch {
    // Not an Expo project (or config-plugins unavailable); no-op.
    return config
  }
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      runGenerate(cfg.modRequest.projectRoot, props)
      return cfg
    },
  ])
}

module.exports = withNitroProtobuf

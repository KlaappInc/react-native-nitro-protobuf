import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const exampleDir = path.join(repoRoot, 'example')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    const joined = [command, ...args].join(' ')
    throw new Error(`Command failed (${result.status}): ${joined}`)
  }
}

function killMetroPorts(ports = [8081, 8082]) {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const lines = output.split('\n')
      const pids = new Set()
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 5) continue
        const local = parts[1]
        const state = parts[3]
        const pid = parts[4]
        if (!local) continue
        for (const port of ports) {
          if (local.endsWith(`:${port}`) && state === 'LISTENING') {
            pids.add(pid)
          }
        }
      }
      for (const pid of pids) {
        run('taskkill', ['/PID', pid, '/T', '/F'])
      }
    } catch {
      // Ignore failures; script is best-effort.
    }
    return
  }

  for (const port of ports) {
    try {
      const output = execFileSync('lsof', ['-ti', `tcp:${port}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const pids = output
        .split(/\s+/)
        .map((pid) => pid.trim())
        .filter(Boolean)
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGTERM')
        } catch {
          // Ignore failures; process may have exited.
        }
      }
    } catch {
      // lsof not available or no process; ignore.
    }
  }
}

function ensureExampleInstall() {
  const nodeModules = path.join(exampleDir, 'node_modules')
  if (!fs.existsSync(nodeModules)) {
    run('npm', ['install'], { cwd: exampleDir })
  }
}

function pickSimulator() {
  const output = execFileSync(
    'xcrun',
    ['simctl', 'list', 'devices', 'available', '-j'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  )
  const data = JSON.parse(output)
  const allDevices = Object.values(data.devices ?? {}).flat()
  const iphones = allDevices.filter(
    (device) => device.isAvailable && /^iPhone/.test(device.name)
  )
  const booted = iphones.find((device) => device.state === 'Booted')
  return booted ?? iphones[0] ?? null
}

const platform = process.argv[2]
if (platform !== 'ios' && platform !== 'android') {
  console.error('Usage: node scripts/run-example.mjs <ios|android>')
  process.exit(1)
}

ensureExampleInstall()
run('npm', ['run', 'proto:generate'], { cwd: exampleDir })
killMetroPorts()

if (platform === 'ios') {
  const iosDir = path.join(exampleDir, 'ios')
  // Prefer Bundler's pinned CocoaPods, but fall back to a global `pod` when
  // Bundler is unavailable/incompatible (e.g. the vendored bundler vs Ruby 4).
  const bundled = spawnSync('bundle', ['exec', 'pod', 'install'], {
    stdio: 'inherit',
    cwd: iosDir,
  })
  if (bundled.status !== 0) {
    console.warn(
      'bundle exec pod install failed; falling back to `pod install`'
    )
    run('pod', ['install'], { cwd: iosDir })
  }

  let simulator = null
  try {
    simulator = pickSimulator()
  } catch (error) {
    throw new Error(`Failed to list iOS simulators: ${error}`)
  }

  if (!simulator) {
    throw new Error('No available iPhone simulator found. Create one in Xcode.')
  }

  console.log(`Using simulator: ${simulator.name} (${simulator.udid})`)
  run(
    'npx',
    ['react-native', 'run-ios', '--udid', simulator.udid, '--port', '8081'],
    { cwd: exampleDir }
  )
} else {
  run('npx', ['react-native', 'run-android', '--port', '8081'], {
    cwd: exampleDir,
  })
}

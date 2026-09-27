import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync
} from 'node:fs'
import { arch, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { validateWindowsMfProbeReport } from './lib/windows-mf-probe.mjs'

const args = process.argv.slice(2).filter((arg) => arg !== '--')
const option = (name) => {
  const index = args.indexOf(name)
  if (index < 0) return null
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`)
  return args.splice(index, 2)[1]
}
const backend = resolve(
  option('--backend') ??
    join(process.env.CARGO_TARGET_DIR ?? 'target', 'debug', 'videorc-backend.exe')
)
const output = option('--output')
if (process.platform !== 'win32')
  throw new Error('Media Foundation probe measurements require Windows')
if (!existsSync(backend))
  throw new Error('Build or select the exact Windows backend executable first')
const database = resolve(
  process.env.VIDEORC_DATABASE_PATH ?? join(process.env.APPDATA, 'Videorc', 'videorc.sqlite3')
)
const reportPath = join(dirname(database), 'windows-mf-probe.json')
const backendSha256 = createHash('sha256').update(readFileSync(backend)).digest('hex')
const startedAt = Date.now()
const child = spawnSync(backend, ['--windows-mf-probe-matrix', ...args], {
  env: { ...process.env, VIDEORC_DATABASE_PATH: database },
  encoding: 'utf8',
  windowsHide: true,
  timeout: 3 * 60 * 60 * 1000,
  maxBuffer: 2 * 1024 * 1024
})
process.stdout.write(child.stdout ?? '')
process.stderr.write(child.stderr ?? '')
let verdict = { pass: false, failures: ['No bounded probe report was persisted'] }
let reportBytes = null
try {
  const maximum = 2 * 1024 * 1024
  const descriptor = openSync(reportPath, 'r')
  const buffer = Buffer.alloc(maximum + 1)
  let length = 0
  try {
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (!read) break
      length += read
    }
  } finally {
    closeSync(descriptor)
  }
  if (length > maximum) throw new Error('Probe report exceeded bounded read')
  reportBytes = buffer.subarray(0, length)
  const report = JSON.parse(reportBytes.toString('utf8'))
  verdict = validateWindowsMfProbeReport(report, backendSha256)
  if (!(Date.parse(report.generatedAt) >= startedAt - 1000)) {
    verdict.pass = false
    verdict.failures.push('Probe report predates this invocation')
  }
} catch (error) {
  verdict = { pass: false, failures: [`Probe report unavailable or invalid: ${error.message}`] }
}

const envelope = {
  schemaVersion: 1,
  kind: 'videorc.windows-mf-probe-run',
  osRelease: release(),
  architecture: arch(),
  backendSha256,
  ffmpeg: { state: 'not-used', reason: 'Direct Media Foundation COM probe' },
  desktop: { state: 'not-used', reason: 'Standalone backend diagnostic invocation' },
  childExitCode: child.status,
  childSignal: child.signal,
  verdict
}
if (output) {
  const directory = resolve(output)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'mf-probe-run.json'), JSON.stringify(envelope, null, 2))
  if (reportBytes) writeFileSync(join(directory, 'windows-mf-probe.json'), reportBytes)
}
console.log(JSON.stringify(envelope, null, 2))
process.exitCode = child.status === 0 && verdict.pass ? 0 : 1

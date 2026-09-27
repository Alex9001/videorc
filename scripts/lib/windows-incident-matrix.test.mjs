import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildWindowsIncidentMatrix,
  parseWindowsIncidentArgs,
  evaluateWindowsIncidentRun,
  incidentSessionParams,
  incidentProcessGroups,
  executeIncidentAttempt,
  createIncidentReadyParser
} from './windows-incident-matrix.mjs'

test('incident matrix crosses every topology, profile, audio and retry policy three times', () => {
  const cases = buildWindowsIncidentMatrix()
  assert.equal(cases.length, 48)
  assert.equal(
    cases.reduce((count, item) => count + item.repetitions, 0),
    144
  )
  assert.deepEqual([...new Set(cases.map((item) => item.receivers))].sort(), [0, 1, 2])
  const same = cases.find((item) => item.retry === 'same-process')
  const restarted = cases.find((item) => item.retry === 'restart')
  assert.equal(incidentProcessGroups(same).length, 1)
  assert.deepEqual(incidentProcessGroups(same)[0], [1, 2, 3])
  assert.deepEqual(incidentProcessGroups(restarted), [[1], [2], [3]])
  assert.throws(() => parseWindowsIncidentArgs(['--incident', '--runs', '1']))
})

test('dual receiver parameters retain recording, two endpoints and fixed output profile', () => {
  const scenario = buildWindowsIncidentMatrix().find((item) => item.topology === 'record-dual')
  const targets = [1, 2].map((port) => ({
    serverUrl: `rtmp://127.0.0.1:${19000 + port}/live`,
    streamKey: `owned-${port}`
  }))
  const params = incidentSessionParams(scenario, targets)
  assert.equal(params.output.recordEnabled, true)
  assert.equal(params.streaming.enabledTargetIds.length, 2)
  assert.equal(params.streaming.targets.length, 2)
  assert.equal(params.output.video.width, 1920)
  assert.throws(() => incidentSessionParams(scenario, [targets[0]]))
  assert.throws(() =>
    incidentSessionParams(scenario, [
      { ...targets[0], serverUrl: 'rtmp://example.com/live' },
      targets[1]
    ])
  )
})

test('a startup timeout or missing second receiver cannot pass on a recording artifact', () => {
  const scenario = buildWindowsIncidentMatrix().find((item) => item.topology === 'record-dual')
  const report = {
    startOutcome: 'failed',
    cleanup: { backendAlive: false, receiversReaped: true },
    artifacts: [{ role: 'recording', verdict: 'PASS' }],
    evidence: {}
  }
  const verdict = evaluateWindowsIncidentRun(scenario, report)
  assert.equal(verdict.pass, false)
  assert.ok(verdict.failures.some((item) => item.includes('startup')))
  assert.ok(verdict.failures.some((item) => item.includes('receiver-2')))
  assert.ok(verdict.failures.some((item) => item.includes('diagnostics')))
})

test('worker and direct-fallback evidence cannot be replaced by controlled sine', () => {
  for (const audio of ['worker', 'direct-fallback']) {
    const scenario = buildWindowsIncidentMatrix().find((item) => item.audio === audio)
    const verdict = evaluateWindowsIncidentRun(scenario, {
      startOutcome: 'running',
      evidence: { audioPath: 'controlled', finalDiagnostics: {} },
      artifacts: [],
      cleanup: {}
    })
    assert.equal(verdict.pass, false)
    assert.ok(verdict.failures.some((item) => item.includes('audio')))
  }
})

test('real attempt seam persists failed-start evidence and analyzes both receivers after stop rejection', async () => {
  const calls = []
  const scenario = buildWindowsIncidentMatrix().find((item) => item.topology === 'record-dual')
  const run = await executeIncidentAttempt(scenario, {
    start: async () => {
      calls.push('start')
      throw new Error('positive media timeout')
    },
    measure: async () => {
      throw new Error('must not measure a failed start')
    },
    stop: async () => {
      calls.push('stop')
      throw new Error('stop refused')
    },
    collect: async () => {
      calls.push('collect')
      return {
        sessionId: 'failed-session',
        finalDiagnostics: { sessionId: 'failed-session' },
        ffmpegTail: 'retained before retry'
      }
    },
    reap: async () => {
      calls.push('reap')
      return { receiversReaped: true }
    },
    analyze: async () => {
      calls.push('analyze')
      return [
        { role: 'receiver-1', verdict: 'FAIL' },
        { role: 'receiver-2', verdict: 'FAIL' }
      ]
    }
  })
  assert.deepEqual(calls, ['start', 'stop', 'collect', 'reap', 'analyze'])
  assert.equal(run.failure, 'positive media timeout')
  assert.equal(run.evidence.sessionId, 'failed-session')
  assert.equal(run.evidence.ffmpegTail, 'retained before retry')
  assert.equal(run.cleanup.receiversReaped, true)
  assert.equal(run.artifacts.length, 2)
  assert.equal(run.verdict.pass, false)
})

test('backend readiness waits for complete fragmented line and rejects overlong output', () => {
  const ready = []
  const errors = []
  const feed = createIncidentReadyParser(
    (value) => ready.push(value),
    (error) => errors.push(error)
  )
  feed('READY {"po')
  feed('rt":1234}')
  assert.equal(ready.length, 0)
  feed('\n')
  assert.deepEqual(ready, [{ port: 1234 }])
  assert.equal(errors.length, 0)
  const tooLong = createIncidentReadyParser(
    () => assert.fail('oversized readiness accepted'),
    (error) => errors.push(error)
  )
  tooLong('x'.repeat(64001))
  assert.equal(errors.length, 1)
})

test('receiver cleanup attempts every owned child and fails closed after first rejection', async () => {
  const { reapIncidentReceivers } = await import('./windows-incident-runner.mjs')
  const calls = []
  const receivers = [1, 2].map((pid) => ({ child: { pid }, stderr: () => 'retained' }))
  const result = await reapIncidentReceivers(
    receivers,
    async (child) => {
      calls.push(child.pid)
      if (child.pid === 1) throw new Error('bounded cleanup failed')
      return { childExited: true }
    },
    async () => false
  )
  assert.deepEqual(calls, [1, 2])
  assert.equal(result.receiversReaped, false)
  assert.equal(result.receiverResults[0].cleanup.state, 'leaked')
  assert.equal(result.receiverResults[1].cleanup.childExited, true)
})

test('owned receiver spawn failure rejects through an error listener and removes readiness listeners', async () => {
  const { EventEmitter } = await import('node:events')
  const { waitIncidentSpawn } = await import('./windows-incident-runner.mjs')
  const child = new EventEmitter()
  const ready = waitIncidentSpawn(child, 1000)
  child.emit('error', new Error('ENOENT'))
  await assert.rejects(ready, /ENOENT/)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('spawn'), 0)
})

test('missing physical prerequisites remain blocked while actual failures take precedence', async () => {
  const { incidentAggregateVerdict } = await import('./windows-incident-runner.mjs')
  const blocked = { state: 'BLOCKED', verdict: { pass: false } }
  const passed = { verdict: { pass: true } }
  const failed = { verdict: { pass: false } }
  assert.equal(incidentAggregateVerdict([blocked, passed], 2), 'BLOCKED')
  assert.equal(incidentAggregateVerdict([blocked, failed], 2), 'FAIL')
  assert.equal(incidentAggregateVerdict([passed], 1), 'PASS')
})

test('unsafe startup cleanup cannot become safe when no receiver reached the owned list', async () => {
  const scenario = buildWindowsIncidentMatrix()[0]
  const run = await executeIncidentAttempt(scenario, {
    start: async () => {
      throw Object.assign(new Error('unreaped startup receiver'), { unsafeCleanup: true })
    },
    measure: async () => assert.fail('failed startup measured'),
    stop: async () => ({ sessionIdle: true }),
    collect: async () => ({}),
    reap: async () => ({ receiversReaped: true }),
    analyze: async () => []
  })
  assert.equal(run.unsafeCleanup, true)
  assert.equal(run.cleanup.receiversReaped, false)
  assert.equal(run.verdict.pass, false)
  assert.ok(run.verdict.failures.includes('owned output cleanup incomplete'))
})

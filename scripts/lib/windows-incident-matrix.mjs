// Diagnostic incident coverage, deliberately separate from protected performance qualification.
export function buildWindowsIncidentMatrix() {
  return [1080, 720].flatMap((height) =>
    ['record', 'single', 'dual', 'record-dual'].flatMap((topology) =>
      ['controlled', 'worker', 'direct-fallback'].flatMap((audio) =>
        ['same-process', 'restart'].map((retry) => ({
          id: `${height}p30-${topology}-${audio}-${retry}`,
          width: height === 1080 ? 1920 : 1280,
          height,
          fps: 30,
          bitrateKbps: 6000,
          topology,
          audio,
          retry,
          recordEnabled: topology === 'record' || topology === 'record-dual',
          receivers: topology === 'record' ? 0 : topology === 'single' ? 1 : 2,
          repetitions: 3,
          durationMs: 12000,
          preview: 'backend-compositor-no-presenter'
        }))
      )
    )
  )
}

export function incidentProcessGroups(scenario) {
  const runs = Array.from({ length: scenario.repetitions }, (_, index) => index + 1)
  return scenario.retry === 'same-process' ? [runs] : runs.map((run) => [run])
}

export function createIncidentReadyParser(onReady, onError) {
  let pending = ''
  let bytes = 0
  let complete = false
  return (chunk) => {
    if (complete) return
    bytes += Buffer.byteLength(chunk)
    if (bytes > 64000) {
      complete = true
      onError(new Error('Backend READY exceeded bounded output'))
      return
    }
    pending += chunk.toString()
    let newline
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (!line.startsWith('READY ')) continue
      complete = true
      try {
        onReady(JSON.parse(line.slice(6)))
      } catch {
        onError(new Error('Malformed backend READY'))
      }
      return
    }
  }
}

export function parseWindowsIncidentArgs(argv) {
  const args = argv.filter((arg) => arg !== '--')
  const result = {
    list: false,
    scenario: null,
    audio: null,
    backend: null,
    output: null,
    microphone: null
  }
  while (args.length) {
    const flag = args.shift()
    if (flag === '--incident') continue
    if (flag === '--list') {
      result.list = true
      continue
    }
    const key = {
      '--scenario': 'scenario',
      '--audio': 'audio',
      '--backend': 'backend',
      '--output': 'output',
      '--microphone': 'microphone'
    }[flag]
    if (!key || !args[0] || args[0].startsWith('--'))
      throw new Error(`Unknown or incomplete incident option: ${flag}`)
    if (result[key] !== null) throw new Error(`Duplicate incident option: ${flag}`)
    result[key] = args.shift()
  }
  result.scenarios = buildWindowsIncidentMatrix().filter(
    (scenario) =>
      (!result.scenario || scenario.id === result.scenario) &&
      (!result.audio || scenario.audio === result.audio)
  )
  if (!result.scenarios.length) throw new Error('Incident selection contains no cases')
  return result
}

export function assertOwnedLoopbackTarget(target) {
  const url = new URL(target.serverUrl)
  if (
    url.protocol !== 'rtmp:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/live' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(target.streamKey)
  ) {
    throw new Error('Incident destinations must be runner-owned literal loopback receivers')
  }
}

export function incidentSessionParams(scenario, targets, microphoneId) {
  if (targets.length !== scenario.receivers) throw new Error('Missing incident receiver')
  targets.forEach(assertOwnedLoopbackTarget)
  if (scenario.audio !== 'controlled' && !microphoneId)
    throw new Error('Physical microphone required for worker/fallback incident case')
  const now = new Date().toISOString()
  const video = {
    preset: 'custom',
    width: scenario.width,
    height: scenario.height,
    fps: scenario.fps,
    bitrateKbps: scenario.bitrateKbps
  }
  const transform = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
  return {
    sources: { testPattern: true, ...(microphoneId ? { microphoneId } : {}) },
    scene: {
      id: 'incident-motion',
      name: 'Incident synthetic motion',
      sources: [
        {
          id: 'source:test-pattern',
          name: 'Moving diagnostic source',
          kind: 'test-pattern',
          transform,
          defaultTransform: transform,
          visible: true,
          locked: false
        }
      ],
      outputs: []
    },
    layout: {
      layoutPreset: 'screen-only',
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraMargin: 32,
      cameraFit: 'fill',
      cameraMirror: false,
      cameraZoom: 100,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      sideBySideSplit: '70-30',
      sideBySideCameraSide: 'right'
    },
    output: {
      recordEnabled: scenario.recordEnabled,
      streamEnabled: targets.length > 0,
      video,
      rtmp: {
        preset: 'custom',
        serverUrl: targets[0]?.serverUrl ?? '',
        streamKey: targets[0]?.streamKey ?? ''
      }
    },
    streaming: {
      enabled: targets.length > 0,
      mode: targets.length > 1 ? 'multi' : 'single',
      defaultOutputPreset: 'custom',
      defaultBitrateKbps: scenario.bitrateKbps,
      enabledTargetIds: targets.map((_, index) => `incident-${index}`),
      selectedTargetId: targets.length ? 'incident-0' : null,
      targets: targets.map((target, index) => ({
        id: `incident-${index}`,
        platform: 'custom',
        label: `Owned loopback receiver ${index + 1}`,
        enabled: true,
        serverUrl: target.serverUrl,
        streamKey: target.streamKey,
        urlMode: 'server-and-key',
        streamKeyPresent: true,
        authMode: 'manual-rtmp',
        createdAt: now,
        updatedAt: now
      }))
    },
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 }
  }
}

export function evaluateWindowsIncidentRun(scenario, run) {
  const failures = []
  if (run.startOutcome !== 'running') failures.push('startup did not reach running')
  const evidence = run.evidence ?? {}
  if (!evidence.finalDiagnostics || !evidence.sessionId)
    failures.push('session diagnostics missing')
  if (!evidence.ffmpegStartup || !evidence.ffmpegTail)
    failures.push('retained FFmpeg startup/tail evidence missing')
  if (!evidence.startTimeline || !evidence.stopTimeline)
    failures.push('startup/cleanup timeline missing')
  if (!Number.isFinite(evidence.bridgeFrames) || evidence.bridgeFrames <= 0)
    failures.push('bridge frame evidence missing')
  if (evidence.effectiveEncoder !== 'libopenh264' || evidence.effectiveOutput !== 'raw-yuv420p')
    failures.push('requested raw/OpenH264 path was not observed')
  if (evidence.audioPath !== scenario.audio) failures.push('requested audio path was not observed')
  if (scenario.audio === 'worker' && !(evidence.firstPcm?.frames > 0))
    failures.push('worker PCM was not observed')
  if (
    scenario.audio === 'direct-fallback' &&
    !evidence.fallbackReason?.includes('Injected incident capture-worker')
  )
    failures.push('injected worker fallback was not observed')
  if (!run.cleanup?.receiversReaped || !run.cleanup?.sessionIdle)
    failures.push('owned output cleanup incomplete')
  const expected = [
    ...(scenario.recordEnabled ? ['recording'] : []),
    ...Array.from({ length: scenario.receivers }, (_, index) => `receiver-${index + 1}`)
  ]
  for (const role of expected) {
    const artifact = run.artifacts?.find((item) => item.role === role)
    if (
      !artifact ||
      artifact.verdict !== 'PASS' ||
      artifact.width !== scenario.width ||
      artifact.height !== scenario.height ||
      artifact.hasAudio !== true
    )
      failures.push(`${role} analyzed A/V artifact missing or failed`)
  }
  return { pass: failures.length === 0, failures }
}

// This is the real runner's failure seam. Every start result, including a
// rejected RPC, reaches collection and owned cleanup before the next retry.
export async function executeIncidentAttempt(scenario, operations) {
  const run = {
    startOutcome: 'failed',
    failure: null,
    cleanup: {},
    evidence: {},
    artifacts: [],
    errors: []
  }
  try {
    const started = await operations.start()
    if (!['recording', 'streaming'].includes(started?.state))
      throw new Error(`Unexpected start state: ${started?.state}`)
    run.startOutcome = 'running'
    await operations.measure()
  } catch (error) {
    run.failure = String(error?.message ?? error)
    run.unsafeCleanup = error?.unsafeCleanup === true
  } finally {
    for (const [name, operation] of [
      ['cleanup', operations.stop],
      ['evidence', operations.collect],
      ['cleanup', operations.reap]
    ]) {
      try {
        Object.assign(run[name], await operation())
      } catch (error) {
        run.errors.push(`${name}: ${String(error?.message ?? error)}`)
      }
    }
    try {
      run.artifacts = await operations.analyze()
    } catch (error) {
      run.errors.push(`artifact analysis: ${String(error?.message ?? error)}`)
    }
  }
  if (run.unsafeCleanup) run.cleanup.receiversReaped = false
  const verdict = evaluateWindowsIncidentRun(scenario, run)
  run.verdict = {
    pass: verdict.pass && run.errors.length === 0 && run.failure === null,
    failures: [...verdict.failures, ...run.errors, ...(run.failure ? [run.failure] : [])]
  }
  return run
}

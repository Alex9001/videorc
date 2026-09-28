import assert from 'node:assert/strict'
import test from 'node:test'
import { validateWindowsMfProbeReport } from './windows-mf-probe.mjs'

const sample = () => {
  const configuration = {
    width: 1920,
    height: 1080,
    fps: 30,
    requestedBitrateKbps: 6000,
    bitrateKbps: 6000,
    subtype: 'I420',
    d3d11Upload: false,
    videoSupport: false,
    multithreadProtected: false
  }
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-mf-probe',
    platform: 'windows',
    backendSha256: 'a'.repeat(64),
    cases: [configuration],
    inventory: [],
    inventoryError: null,
    measurementComplete: true,
    attempts: [
      {
        case: configuration,
        encoder: null,
        state: 'no-encoder',
        stage: 'enumerate',
        idr: false,
        childReady: true,
        childReaped: true
      }
    ]
  }
}
test('hosted no-encoder inventory completes measurement without claiming hardware acceptance', () => {
  const verdict = validateWindowsMfProbeReport(sample(), 'a'.repeat(64))
  assert.equal(verdict.pass, true)
  assert.equal(verdict.idrAttempts, 0)
  assert.match(verdict.hardwareAcceptance, /not-measured/)
})
test('probe refuses substituted binary, missing rows and silently substituted subtype', () => {
  assert.equal(validateWindowsMfProbeReport(sample(), 'b'.repeat(64)).pass, false)
  const missing = sample()
  missing.attempts = []
  assert.equal(validateWindowsMfProbeReport(missing).pass, false)
  const substituted = sample()
  substituted.inventory = [{ index: 0, name: 'Fixture encoder' }]
  Object.assign(substituted.attempts[0], {
    state: 'encoded-idr',
    stage: 'complete',
    encoder: substituted.inventory[0],
    idr: true,
    encodedFrames: 6,
    actualSubtype: 'NV12',
    actualD3d11Upload: false
  })
  assert.equal(validateWindowsMfProbeReport(substituted).pass, false)
})

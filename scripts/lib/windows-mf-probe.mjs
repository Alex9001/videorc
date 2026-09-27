export function validateWindowsMfProbeReport(report, expectedBackendSha256) {
  const failures = []
  if (
    report?.schemaVersion !== 1 ||
    report?.kind !== 'videorc.windows-mf-probe' ||
    report?.platform !== 'windows'
  )
    failures.push('probe schema/platform identity invalid')
  if (
    !/^[a-f0-9]{64}$/.test(report?.backendSha256 ?? '') ||
    (expectedBackendSha256 && report.backendSha256 !== expectedBackendSha256)
  )
    failures.push('probe backend digest mismatch')
  if (!Array.isArray(report?.cases) || !report.cases.length || report.cases.length > 36)
    failures.push('probe cases missing or unbounded')
  if (!Array.isArray(report?.inventory) || report.inventory.length > 8)
    failures.push('probe inventory missing or unbounded')
  const cases = Array.isArray(report?.cases) ? report.cases : []
  const inventory = Array.isArray(report?.inventory) ? report.inventory : []
  const attempts = Array.isArray(report?.attempts) ? report.attempts : []
  if (
    !report?.measurementComplete ||
    report.inventoryError ||
    attempts.length !== cases.length * Math.max(1, inventory.length)
  )
    failures.push('probe measurement incomplete')
  for (const [index, attempt] of attempts.entries()) {
    const expectedCase = cases[Math.floor(index / Math.max(1, inventory.length))]
    if (JSON.stringify(attempt.case) !== JSON.stringify(expectedCase))
      failures.push(`attempt ${index} configuration identity mismatch`)
    if (!attempt.childReaped || !attempt.childReady)
      failures.push(`attempt ${index} child readiness/cleanup missing`)
    if (!['encoded-idr', 'rejected', 'no-encoder'].includes(attempt.state))
      failures.push(`attempt ${index} supervisor failed`)
    if (
      attempt.state === 'no-encoder' &&
      (inventory.length || attempt.idr || attempt.stage !== 'enumerate')
    )
      failures.push(`attempt ${index} false no-encoder result`)
    if (
      attempt.state === 'encoded-idr' &&
      (!attempt.idr ||
        !(attempt.encodedFrames > 0) ||
        attempt.actualSubtype !== attempt.case.subtype ||
        attempt.actualD3d11Upload !== attempt.case.d3d11Upload ||
        (attempt.case.d3d11Upload &&
          (attempt.actualVideoSupport !== attempt.case.videoSupport ||
            attempt.actualMultithreadProtected !== attempt.case.multithreadProtected)))
    )
      failures.push(`attempt ${index} does not prove its exact requested variant`)
    if (
      inventory.length &&
      JSON.stringify(attempt.encoder) !== JSON.stringify(inventory[index % inventory.length])
    )
      failures.push(`attempt ${index} encoder identity mismatch`)
  }
  return {
    pass: failures.length === 0,
    failures,
    measurementComplete: report?.measurementComplete === true,
    idrAttempts: attempts.filter((attempt) => attempt.state === 'encoded-idr').length,
    hardwareAcceptance: 'not-measured; six-frame probe is not sustained media acceptance'
  }
}

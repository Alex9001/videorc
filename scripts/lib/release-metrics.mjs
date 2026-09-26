const timestamp = (value) => (value ? Date.parse(value) : null)
const duration = (start, end) => (start === null || end === null ? null : Math.max(0, end - start))

export function releaseRunMetrics({ run, jobs, pending = [], now = Date.now() }) {
  const created = timestamp(run.created_at)
  const phases = jobs.map((job) => {
    const steps = (job.steps ?? []).filter(
      (step) => step.started_at && !['skipped', 'cancelled'].includes(step.conclusion)
    )
    const first = steps.length ? Math.min(...steps.map((step) => timestamp(step.started_at))) : null
    const last = steps.length
      ? Math.max(...steps.map((step) => timestamp(step.completed_at) ?? now))
      : null
    return {
      name: job.name,
      conclusion: job.conclusion,
      executed: steps.length > 0,
      executionMs: duration(first, last),
      elapsedToFirstStepMs: duration(created, first),
      steps: steps.map((step) => ({
        name: step.name,
        conclusion: step.conclusion,
        durationMs: duration(timestamp(step.started_at), timestamp(step.completed_at) ?? now)
      }))
    }
  })
  return {
    runId: run.id,
    createdAt: run.created_at,
    completedAt: run.status === 'completed' ? run.updated_at : null,
    attempt: run.run_attempt,
    url: run.html_url,
    status: run.status,
    conclusion: run.conclusion,
    elapsedMs: duration(created, run.status === 'completed' ? timestamp(run.updated_at) : now),
    blocker: pending.length
      ? 'environment-approval'
      : run.status === 'pending'
        ? 'concurrency'
        : run.status === 'queued'
          ? 'runner-allocation'
          : null,
    // GitHub does not expose each transition timestamp. Do not invent a queue split.
    queueBreakdown: 'observed-state-only',
    phases
  }
}

export function summarizeReleaseMetrics(receipts) {
  const summary = {}
  for (const category of ['cold', 'warm']) {
    const values = receipts
      .filter((entry) => entry.cache === category && Number.isFinite(entry.candidateMs))
      .map((entry) => entry.candidateMs)
      .sort((a, b) => a - b)
    summary[category] = {
      samples: values.length,
      p50: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
      p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null
    }
  }
  return summary
}

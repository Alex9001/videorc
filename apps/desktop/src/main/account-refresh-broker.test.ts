import { describe, expect, it, vi } from 'vitest'

import { AccountRefreshBroker } from './account-refresh-broker'

describe('AccountRefreshBroker', () => {
  it('coalesces concurrent focus and timer refreshes onto one admin request', async () => {
    let resolveRequest!: (value: string) => void
    const request = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRequest = resolve
        })
    )
    const broker = new AccountRefreshBroker(() => false, request)

    const first = broker.refresh()
    const second = broker.refresh()
    expect(second).toBe(first)
    expect(request).toHaveBeenCalledTimes(1)

    resolveRequest('account')
    await expect(first).resolves.toEqual({ outcome: 'refreshed', snapshot: 'account' })
    await expect(second).resolves.toEqual({ outcome: 'refreshed', snapshot: 'account' })
  })

  it('defers maintenance while capture is active without opening an admin request', async () => {
    const request = vi.fn(async () => 'account')
    const broker = new AccountRefreshBroker(() => true, request)

    // Deferral is an answer, not an error: nothing reaches the renderer's
    // error toast, and no admin request is opened during capture.
    await expect(broker.refresh()).resolves.toEqual({ outcome: 'deferred' })
    expect(request).not.toHaveBeenCalled()
  })

  it('clears a failed single-flight request so a later focus can retry', async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('account')
    const broker = new AccountRefreshBroker(() => false, request)

    await expect(broker.refresh()).rejects.toThrow('offline')
    await expect(broker.refresh()).resolves.toEqual({ outcome: 'refreshed', snapshot: 'account' })
    expect(request).toHaveBeenCalledTimes(2)
  })
})

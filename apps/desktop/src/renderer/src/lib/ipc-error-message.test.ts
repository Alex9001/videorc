import { describe, expect, it } from 'vitest'

import { ipcErrorMessage } from './ipc-error-message'

describe('ipcErrorMessage', () => {
  it("strips Electron's remote-method wrapper and the rethrown class name", () => {
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'account:refresh': Error: Account provider is offline."
        )
      )
    ).toBe('Account provider is offline.')
    expect(
      ipcErrorMessage(
        new Error("Error invoking remote method 'sessions:open': TypeError: Path is not a string.")
      )
    ).toBe('Path is not a string.')
  })

  it('strips only the outer wrapper when the message itself says Error:', () => {
    expect(
      ipcErrorMessage(
        new Error("Error invoking remote method 'x:y': Error: Error: backend closed early.")
      )
    ).toBe('Error: backend closed early.')
  })

  it('passes through a message without the wrapper, and non-Error values', () => {
    expect(ipcErrorMessage(new Error('Backend request timed out.'))).toBe(
      'Backend request timed out.'
    )
    expect(ipcErrorMessage("mid-sentence Error invoking remote method 'a:b': x")).toBe(
      "mid-sentence Error invoking remote method 'a:b': x"
    )
    expect(ipcErrorMessage('plain string')).toBe('plain string')
  })
})

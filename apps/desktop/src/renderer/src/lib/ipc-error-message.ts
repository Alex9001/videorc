// Electron re-throws a rejected `ipcMain.handle` in the renderer as
// "Error invoking remote method '<channel>': Error: <message>". The channel and
// class name are transport noise; only the handler's own message belongs in
// front of a user (plan 073: the live account-refresh toast showed both).
const ELECTRON_IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/

export function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(ELECTRON_IPC_ERROR_PREFIX, '')
}

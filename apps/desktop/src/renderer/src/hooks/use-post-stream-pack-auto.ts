import { useSyncExternalStore } from 'react'

import {
  POST_STREAM_PACK_AUTO_STORAGE_KEY,
  postStreamPackAutoFromStorage,
  postStreamPackAutoToStorage
} from '@/lib/post-stream-pack'

// "Make my post-stream pack automatically" is a renderer-local preference
// (one localStorage flag), like the co-host sensitivity. Without an explicit
// choice it follows Orcle listening (on exactly when listening is on). The
// Publish tab writes it; the auto-run reads the same key when a session
// finalizes (lib/post-stream-pack.ts), so there is no second copy to sync.

const listeners = new Set<() => void>()

function readPostStreamPackAuto(listenOn: boolean): boolean {
  try {
    return postStreamPackAutoFromStorage(
      localStorage.getItem(POST_STREAM_PACK_AUTO_STORAGE_KEY),
      listenOn
    )
  } catch {
    return listenOn
  }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === POST_STREAM_PACK_AUTO_STORAGE_KEY) listener()
  }
  listeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function setPostStreamPackAuto(enabled: boolean): void {
  try {
    localStorage.setItem(POST_STREAM_PACK_AUTO_STORAGE_KEY, postStreamPackAutoToStorage(enabled))
  } catch {
    // Storage unavailable: the choice simply does not outlive this window.
  }
  for (const listener of listeners) listener()
}

/** The effective preference; `listenOn` is `cohost.settings.listen`. */
export function usePostStreamPackAuto(listenOn: boolean): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readPostStreamPackAuto(listenOn),
    () => listenOn
  )
}

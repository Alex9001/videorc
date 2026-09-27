import { useSyncExternalStore } from 'react'

import {
  POST_STREAM_PACK_AUTO_STORAGE_KEY,
  postStreamPackAutoFromStorage,
  postStreamPackAutoToStorage
} from '@/lib/post-stream-pack'

// "Make my post-stream pack automatically" is a renderer-local preference
// (one localStorage flag, default on), like the co-host sensitivity. The
// Publish tab writes it; the auto-run reads the same key when a session
// finalizes (lib/post-stream-pack.ts), so there is no second copy to sync.

const listeners = new Set<() => void>()

function readPostStreamPackAuto(): boolean {
  try {
    return postStreamPackAutoFromStorage(localStorage.getItem(POST_STREAM_PACK_AUTO_STORAGE_KEY))
  } catch {
    return true
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

export function usePostStreamPackAuto(): boolean {
  return useSyncExternalStore(subscribe, readPostStreamPackAuto, () => true)
}

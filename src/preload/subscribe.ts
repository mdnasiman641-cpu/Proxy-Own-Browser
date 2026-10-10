import { ipcRenderer, type IpcRendererEvent } from 'electron'

/** Subscribes to a main-process event and returns an unsubscribe function. */
export function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

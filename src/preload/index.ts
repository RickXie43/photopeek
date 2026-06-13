import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {}

// Custom event listeners for share features
const shareApi = {
  onUsersUpdate: (callback: (data: { eventId: string; users: { id: string; nickname: string; joinedAt: string }[] }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any): void => callback(data)
    ipcRenderer.on('share:users-update', handler)
    return () => ipcRenderer.removeListener('share:users-update', handler)
  },
  onTagAction: (callback: (data: { eventId: string; userId: string; nickname: string; action: 'added' | 'removed'; photoId: string; tagName: string; timestamp: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any): void => callback(data)
    ipcRenderer.on('share:tag-action', handler)
    return () => ipcRenderer.removeListener('share:tag-action', handler)
  },
  onTunnelStatus: (callback: (data: { eventId: string; active: boolean; url?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any): void => callback(data)
    ipcRenderer.on('share:tunnel-status', handler)
    return () => ipcRenderer.removeListener('share:tunnel-status', handler)
  },
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('shareApi', shareApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.shareApi = shareApi
}

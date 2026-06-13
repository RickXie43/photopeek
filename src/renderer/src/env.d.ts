/// <reference types="vite/client" />

interface ElectronAPI {
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => void
    on: (channel: string, listener: (...args: unknown[]) => void) => () => void
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => void
  }
}

interface Window {
  electron: ElectronAPI
  api: Record<string, unknown>
}

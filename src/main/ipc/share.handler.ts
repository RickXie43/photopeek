import { ipcMain } from 'electron'
import { startShare, stopShare, stopAllShares, getShareStatus, startTunnel, stopTunnel, getTunnelStatus } from '../services/share.service'

export function registerShareHandlers(): void {
  ipcMain.handle('share:start', async (_event, params: { eventId: string; port?: number }) => {
    try {
      const result = await startShare(params.eventId, params.port || 0)
      return { success: true, ...result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('share:stop', async (_event, eventId: string) => {
    stopShare(eventId)
    return { success: true }
  })

  ipcMain.handle('share:status', async (_event, eventId: string) => {
    return getShareStatus(eventId)
  })

  ipcMain.handle('share:listeners', async (_event, eventId: string) => {
    const status = getShareStatus(eventId)
    return status.active ? (status.users || []) : []
  })

  ipcMain.handle('share:stopAll', async () => {
    stopAllShares()
    return { success: true }
  })

  // ─── Tunnel IPC ────────────────────────────────────────────────────

  ipcMain.handle('share:tunnelStart', async (_event, eventId: string) => {
    try {
      const result = await startTunnel(eventId)
      return { success: true, ...result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('share:tunnelStop', async (_event, eventId: string) => {
    stopTunnel(eventId)
    return { success: true }
  })

  ipcMain.handle('share:tunnelStatus', async (_event, eventId: string) => {
    return getTunnelStatus(eventId)
  })
}

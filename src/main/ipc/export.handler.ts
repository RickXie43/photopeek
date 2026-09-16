import { ipcMain, dialog, BrowserWindow } from 'electron'
import { executeExport, cancelExport } from '../services/export.service'
import { exportEventPackage } from '../services/event-package.service'

export function registerExportHandlers(): void {
  ipcMain.handle('export:selectFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择导出文件夹'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('export:execute', async (_event, options) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) {
      return { success: false, exported: 0, skipped: 0, errors: ['没有窗口'] }
    }

    const sendProgress = (progress: {
      current: number
      total: number
      message: string
      percent: number
    }): void => {
      if (!win.isDestroyed()) {
        win.webContents.send('export:progress', progress)
      }
    }

    try {
      return await executeExport(options, sendProgress)
    } catch (err) {
      console.error('[Export] execute failed:', err)
      return {
        success: false,
        exported: 0,
        skipped: 0,
        errors: [`导出执行失败: ${(err as Error).message}`]
      }
    }
  })

  ipcMain.handle(
    'export:executeEvent',
    async (_event, data: { eventId: string; parentFolder: string }) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win)
        return { success: false, exported: 0, imported: 0, skipped: 0, errors: ['没有窗口'] }
      const sendProgress = (progress: {
        current: number
        total: number
        message: string
        percent: number
      }): void => {
        if (!win.isDestroyed()) win.webContents.send('export:progress', progress)
      }
      try {
        return await exportEventPackage(data.eventId, data.parentFolder, sendProgress)
      } catch (err) {
        return {
          success: false,
          exported: 0,
          imported: 0,
          skipped: 0,
          errors: [`事件导出失败: ${(err as Error).message}`]
        }
      }
    }
  )

  ipcMain.handle('export:cancel', async () => {
    cancelExport()
    return { success: true }
  })
}

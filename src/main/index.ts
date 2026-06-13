import { app, shell, BrowserWindow, ipcMain, protocol } from 'electron'
import * as path from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDatabase, saveDatabase, closeDatabase } from './db/connection'
import { registerEventHandlers } from './ipc/event.handler'
import { registerPhotoHandlers } from './ipc/photo.handler'
import { registerImportHandlers } from './ipc/import.handler'
import { registerCacheHandlers } from './ipc/cache.handler'
import { registerTagHandlers } from './ipc/tag.handler'
import { registerShareHandlers } from './ipc/share.handler'
import { getConfig, saveConfig, updateLibraryPath, getLibraryPath, type PhotoPeekConfig } from './services/library.service'
import * as fs from 'fs'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: true,
      devTools: true,
    },
  })

  // Log renderer crashes
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details.reason, details.exitCode)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('Page failed to load:', errorCode, errorDescription)
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow = win
  void mainWindow
}

// Register photo scheme BEFORE app ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'photo', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }
])

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.photopeek')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Register photo protocol handler
  protocol.handle('photo', (request) => {
    // URL format: photo:///C:/path/to/file.jpg
    // Must decodeURIComponent to handle non-ASCII characters (e.g. Chinese folder names)
    try {
      const raw = decodeURIComponent(request.url.slice('photo:///'.length))
      // Normalize path: resolve against current drive if needed
      let filePath = raw
      // On Windows, ensure drive letter is uppercase and path separators are correct
      if (process.platform === 'win32') {
        filePath = path.resolve(filePath)
      }
      if (!fs.existsSync(filePath)) {
        console.error('[photo protocol] File not found:', filePath)
        return new Response(null, { status: 404 })
      }
      const buf = fs.readFileSync(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const mimes: Record<string, string> = {
        '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
        '.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp',
      }
      return new Response(buf, {
        headers: { 'content-type': mimes[ext] || 'image/jpeg' }
      })
    } catch (err) {
      console.error('[photo protocol] Error loading:', err)
      return new Response(null, { status: 404 })
    }
  })

  // Initialize database
  await getDatabase()
  console.log('PhotoPeek database initialized')

  // Sync all events' event.json files on startup (ensure consistency)
  try {
    const { getDb } = await import('./db/connection')
    const { syncEventJsonPhotos } = await import('./ipc/event.handler')
    const db = getDb()
    const events = db.exec('SELECT id FROM events WHERE deleted_at IS NULL')
    if (events.length > 0) {
      const { columns, values } = events[0]
      for (const row of values) {
        const id = row[columns.indexOf('id')] as string
        syncEventJsonPhotos(id)
      }
    }
  } catch (err) {
    console.error('Startup event.json sync failed:', err)
  }

  // IPC: read image file and return base64 (fallback for thumbnails)
  ipcMain.handle('image:readBase64', async (_event, filePath: string) => {
    try {
      if (!fs.existsSync(filePath)) return null
      const data = fs.readFileSync(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const mime: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp',
      }
      const contentType = mime[ext] || 'image/jpeg'
      return `data:${contentType};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  })

  // Register IPC handlers
  registerEventHandlers()
  registerPhotoHandlers()
  registerImportHandlers()
  registerCacheHandlers()
  registerTagHandlers()
  registerShareHandlers()

  // Settings IPC
  ipcMain.handle('settings:get', () => {
    return getConfig()
  })

  ipcMain.handle('settings:update', (_event, config: Partial<PhotoPeekConfig>) => {
    return saveConfig(config)
  })

  ipcMain.handle('settings:getLibraryPath', () => {
    return getLibraryPath()
  })

  ipcMain.handle('settings:setLibraryPath', (_event, newPath: string) => {
    updateLibraryPath(newPath)
    return getLibraryPath()
  })

  // IPC: save database
  ipcMain.handle('db:save', () => {
    const data = saveDatabase()
    return data ? Buffer.from(data).toString('base64') : null
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Save database before quitting
app.on('window-all-closed', () => {
  closeDatabase()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  closeDatabase()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

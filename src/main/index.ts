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
  protocol.handle('photo', async (request) => {
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
      const ext = path.extname(filePath).toLowerCase()
      const mimes: Record<string, string> = {
        '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
        '.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp',
      }
      // RAW files: serve embedded JPEG preview directly (no upscaling, keeps camera-native resolution)
      const RAW_EXTS = new Set(['.cr2','.cr3','.nef','.arw','.rw2','.orf','.raf','.dng','.raw','.srf','.sr2'])
      if (RAW_EXTS.has(ext)) {
        const { getRawPreviewBuffer } = await import('./services/thumbnail.service')
        const previewBuf = await getRawPreviewBuffer(filePath)
        if (previewBuf) {
          console.log(`[photo protocol] RAW preview size: ${(previewBuf.length / 1024).toFixed(0)}KB for ${path.basename(filePath)}`)
          return new Response(previewBuf, { headers: { 'content-type': 'image/jpeg' } })
        }
        return new Response(null, { status: 415 })
      }
      const buf = fs.readFileSync(filePath)
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

  // Regenerate missing thumbnails on startup
  try {
    const { getDb } = await import('./db/connection')
    const { generateThumbnail } = await import('./services/thumbnail.service')
    const { getEventFolderName } = await import('./ipc/event.handler')
    const db = getDb()

    // Find all photo_versions that lack thumbnails (thumbnail_path IS NULL or file missing)
    const rows = db.exec(`
      SELECT v.id, v.photo_id, v.file_path, v.file_name, p.event_id
      FROM photo_versions v
      JOIN photos p ON p.id = v.photo_id
      WHERE p.deleted_at IS NULL
        AND (v.thumbnail_path IS NULL OR v.thumbnail_path = '')
    `)
    if (rows.length > 0 && rows[0].values.length > 0) {
      const { columns, values } = rows[0]
      let regenerated = 0
      for (const row of values) {
        const vid = row[columns.indexOf('id')] as string
        const filePath = row[columns.indexOf('file_path')] as string
        const eventId = row[columns.indexOf('event_id')] as string
        if (filePath && fs.existsSync(filePath)) {
          try {
            const folderName = getEventFolderName(eventId)
            const thumbPath = await generateThumbnail(filePath, vid, eventId, folderName)
            if (thumbPath) {
              db.run('UPDATE photo_versions SET thumbnail_path = ? WHERE id = ?', [thumbPath, vid])
              regenerated++
            }
          } catch (err) {
            console.error('[Startup] Failed to regenerate thumbnail for', vid, err)
          }
        }
      }
      if (regenerated > 0) {
        const { persistDatabase } = await import('./db/connection')
        // Sync photos.thumbnail_path to best version's thumbnail
        db.run(`
          UPDATE photos SET thumbnail_path = (
            SELECT v.thumbnail_path FROM photo_versions v
            WHERE v.photo_id = photos.id AND v.thumbnail_path IS NOT NULL AND v.thumbnail_path != ''
            ORDER BY v.is_original DESC LIMIT 1
          )
        `)
        persistDatabase()
        console.log('[Startup] Regenerated', regenerated, 'missing thumbnails')
      }
    }
  } catch (err) {
    console.error('[Startup] Thumbnail regeneration failed:', err)
  }
  // Always sync photos.thumbnail_path from versions on startup (fix existing DB)
  try {
    const { getDb } = await import('./db/connection')
    const db = getDb()
    db.run(`
      UPDATE photos SET thumbnail_path = (
        SELECT v.thumbnail_path FROM photo_versions v
        WHERE v.photo_id = photos.id AND v.thumbnail_path IS NOT NULL AND v.thumbnail_path != ''
        ORDER BY v.is_original DESC, v.created_at ASC LIMIT 1
      )
      WHERE photos.thumbnail_path IS NULL
        AND EXISTS (
          SELECT 1 FROM photo_versions v
          WHERE v.photo_id = photos.id AND v.thumbnail_path IS NOT NULL AND v.thumbnail_path != ''
        )
    `)
    console.log('[Startup] Synced thumbnail_path for photos')
  } catch (err) {
    console.error('[Startup] Thumbnail path sync failed:', err)
  }

  // Migrate: create photo_versions for existing photos that lack them
  try {
    const { getDb } = await import('./db/connection')
    const { v4: uuidV4 } = await import('uuid')
    const db = getDb()
    const orphanRows = db.exec(`
      SELECT p.id, p.file_path, p.file_name, p.file_size, p.width, p.height, p.metadata, p.created_at
      FROM photos p
      WHERE p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM photo_versions v WHERE v.photo_id = p.id)
    `)
    if (orphanRows.length > 0 && orphanRows[0].values.length > 0) {
      const { columns, values } = orphanRows[0]
      let created = 0
      for (const row of values) {
        const photoId = row[columns.indexOf('id')] as string
        const filePath = row[columns.indexOf('file_path')] as string
        const fileName = row[columns.indexOf('file_name')] as string
        const fileSize = row[columns.indexOf('file_size')] as number
        const width = row[columns.indexOf('width')] as number
        const height = row[columns.indexOf('height')] as number
        const metadata = (row[columns.indexOf('metadata')] || null) as string | null
        const createdAt = (row[columns.indexOf('created_at')] || new Date().toISOString()) as string

        const ext = (fileName || '').split('.').pop()?.toLowerCase() || ''
        const rawExts = ['cr2','cr3','nef','arw','rw2','orf','raf','srf','sr2','raw']
        const versionName = rawExts.includes(ext) ? 'RAW'
          : ext === 'dng' ? 'DNG'
          : ext === 'tiff' || ext === 'tif' ? 'TIFF'
          : ext === 'png' ? 'PNG'
          : ext === 'heic' || ext === 'heif' ? 'HEIC'
          : ext === 'avif' ? 'AVIF'
          : '原始文件'

        db.run(`INSERT INTO photo_versions (id, photo_id, version_name, file_path, file_name, file_size, width, height, metadata, is_original, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [uuidV4(), photoId, versionName, filePath, fileName, fileSize, width, height, metadata, createdAt])
        created++
      }
      if (created > 0) {
        const { persistDatabase } = await import('./db/connection')
        persistDatabase()
        console.log('[Startup] Created', created, 'default versions for existing photos')
      }
    }
  } catch (err) {
    console.error('[Startup] Version migration failed:', err)
  }

  // IPC: get file stats (used by version import)
  ipcMain.handle('fs:stat', async (_event, filePath: string) => {
    try {
      const stats = fs.statSync(filePath)
      return { size: stats.size }
    } catch {
      return null
    }
  })

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

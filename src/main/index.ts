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
import { registerUpdateHandlers } from './ipc/update.handler'
import { getConfig, saveConfig, updateLibraryPath, getLibraryPath, getThumbnailsDir, type PhotoPeekConfig } from './services/library.service'
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
        // If file is under thumbnails dir, try to auto-regenerate on the fly
        const thumbnailsDir = getThumbnailsDir()
        if (filePath.startsWith(thumbnailsDir)) {
          try {
            const { generateThumbnail } = await import('./services/thumbnail.service')
            const { getDb } = await import('./db/connection')
            const db = getDb()
            // Normalize path for matching (both DB and request paths use forward slashes)
            const normalizedPath = path.resolve(filePath).replace(/\\/g, '/')
            const vRows = db.exec('SELECT id, photo_id, file_path, file_name, thumbnail_path FROM photo_versions WHERE thumbnail_path IS NOT NULL')
            if (vRows.length > 0 && vRows[0].values.length > 0) {
              const { columns, values } = vRows[0]
              for (const row of values) {
                const dbThumbPath = (row[columns.indexOf('thumbnail_path')] as string) || ''
                if (path.resolve(dbThumbPath).replace(/\\/g, '/') !== normalizedPath) continue
                const versionId = row[columns.indexOf('id')] as string
                const sourcePath = row[columns.indexOf('file_path')] as string
                const photoId = row[columns.indexOf('photo_id')] as string
                if (!sourcePath || !fs.existsSync(sourcePath)) break
                const pRows = db.exec('SELECT event_id FROM photos WHERE id = ?', [photoId])
                if (pRows.length === 0 || pRows[0].values.length === 0) break
                const eventId = pRows[0].values[0][0] as string
                const { getEventFolderName } = await import('./ipc/event.handler')
                const folderName = getEventFolderName(eventId)
                const newPath = await generateThumbnail(sourcePath, versionId, eventId, folderName)
                if (newPath) {
                  db.run('UPDATE photo_versions SET thumbnail_path = ? WHERE id = ?', [newPath, versionId])
                  db.run(`
                    UPDATE photos SET thumbnail_path = (
                      SELECT v.thumbnail_path FROM photo_versions v
                      WHERE v.photo_id = photos.id AND v.thumbnail_path IS NOT NULL AND v.thumbnail_path != ''
                      ORDER BY v.is_original DESC, v.created_at ASC LIMIT 1
                    ) WHERE id = ?
                  `, [photoId])
                  const { persistDatabase } = await import('./db/connection')
                  persistDatabase()
                  console.log('[photo protocol] Auto-regenerated thumbnail:', path.basename(filePath))
                  // Serve the newly generated file
                  const buf = fs.readFileSync(newPath)
                  return new Response(new Uint8Array(buf), {
                    headers: { 'content-type': 'image/jpeg' }
                  })
                }
                break
              }
            }
          } catch (regenErr) {
            console.error('[photo protocol] Auto-regeneration failed:', regenErr)
          }
        }
        console.error('[photo protocol] File not found:', filePath)
        return new Response(null, { status: 404 })
      }
      const ext = path.extname(filePath).toLowerCase()
      const mimes: Record<string, string> = {
        '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
        '.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp',
      }
      // RAW files: serve a large preview (2600px) for best clarity in LoupeView
      const RAW_EXTS = new Set(['.cr2','.cr3','.nef','.arw','.rw2','.orf','.raf','.dng','.raw','.srf','.sr2'])
      if (RAW_EXTS.has(ext)) {
        const { generateLargePreview } = await import('./services/thumbnail.service')
        const previewBuf = await generateLargePreview(filePath)
        if (previewBuf) {
          return new Response(new Uint8Array(previewBuf), { headers: { 'content-type': 'image/jpeg' } })
        }
        return new Response(null, { status: 415 })
      }
      const buf = fs.readFileSync(filePath)
      return new Response(new Uint8Array(buf), {
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

  // Fast: sync photos.thumbnail_path from versions on startup
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

  // IPC: regenerate a missing thumbnail by its file path
  ipcMain.handle('thumbnail:regenerateFromPath', async (_event, thumbFilePath: string) => {
    try {
      if (fs.existsSync(thumbFilePath)) return true // already exists
      const { getDb } = await import('./db/connection')
      const { generateThumbnail, batchGenerateThumbnails } = await import('./services/thumbnail.service')
      const { getEventFolderName } = await import('./ipc/event.handler')
      const db = getDb()

      // Normalize path for matching
      const normalizedPath = path.resolve(thumbFilePath).replace(/\\/g, '/')

      // Find the photo_version that has this thumbnail_path
      const rows = db.exec('SELECT id, photo_id, file_path, file_name FROM photo_versions WHERE thumbnail_path IS NOT NULL')
      if (rows.length === 0 || rows[0].values.length === 0) return false
      const { columns, values } = rows[0]

      for (const row of values) {
        const dbThumbPath = (row[columns.indexOf('thumbnail_path')] as string) || ''
        if (path.resolve(dbThumbPath).replace(/\\/g, '/') !== normalizedPath) continue

        const versionId = row[columns.indexOf('id')] as string
        const filePath = row[columns.indexOf('file_path')] as string
        const photoId = row[columns.indexOf('photo_id')] as string

        // Find event_id from photos table
        const pRows = db.exec('SELECT event_id FROM photos WHERE id = ?', [photoId])
        if (pRows.length === 0 || pRows[0].values.length === 0) return false
        const eventId = pRows[0].values[0][0] as string
        const folderName = getEventFolderName(eventId)

        if (filePath && fs.existsSync(filePath)) {
          const newThumbPath = await generateThumbnail(filePath, versionId, eventId, folderName)
          if (newThumbPath) {
            db.run('UPDATE photo_versions SET thumbnail_path = ? WHERE id = ?', [newThumbPath, versionId])
            // Also update photos.thumbnail_path if this is the best version
            db.run(`
              UPDATE photos SET thumbnail_path = (
                SELECT v.thumbnail_path FROM photo_versions v
                WHERE v.photo_id = photos.id AND v.thumbnail_path IS NOT NULL AND v.thumbnail_path != ''
                ORDER BY v.is_original DESC, v.created_at ASC LIMIT 1
              ) WHERE id = ?
            `, [photoId])
            const { persistDatabase } = await import('./db/connection')
            persistDatabase()
            console.log('[IPC] Regenerated thumbnail for version', versionId)
            return true
          }
        }
        return false
      }
      return false
    } catch (err) {
      console.error('[IPC] thumbnail:regenerateFromPath failed:', err)
      return false
    }
  })

  // Register IPC handlers
  registerEventHandlers()
  registerPhotoHandlers()
  registerImportHandlers()
  registerCacheHandlers()
  registerTagHandlers()
  registerShareHandlers()
  registerUpdateHandlers()

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

  // IPC: restart the application (used after clearing all data)
  ipcMain.handle('app:restart', () => {
    app.relaunch()
    app.quit()
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  // Deferred background startup tasks — run after window is shown
  setTimeout(async () => {
    // Regenerate missing thumbnails on startup (background, non-blocking)
    try {
      const { getDb } = await import('./db/connection')
      const { generateThumbnail } = await import('./services/thumbnail.service')
      const { getEventFolderName } = await import('./ipc/event.handler')
      const db = getDb()

      const vRows = db.exec(`
        SELECT v.id, v.photo_id, v.file_path, v.file_name, v.thumbnail_path, p.event_id
        FROM photo_versions v
        JOIN photos p ON p.id = v.photo_id
        WHERE p.deleted_at IS NULL
          AND v.file_path IS NOT NULL AND v.file_path != ''
      `)
      if (vRows.length > 0 && vRows[0].values.length > 0) {
        const { columns, values } = vRows[0]
        let regenerated = 0
        for (const row of values) {
          const thumbPath = row[columns.indexOf('thumbnail_path')] as string | null
          if (thumbPath && fs.existsSync(thumbPath)) continue

          const vid = row[columns.indexOf('id')] as string
          const filePath = row[columns.indexOf('file_path')] as string
          const eventId = row[columns.indexOf('event_id')] as string
          if (filePath && fs.existsSync(filePath)) {
            try {
              const folderName = getEventFolderName(eventId)
              const thumbPathNew = await generateThumbnail(filePath, vid, eventId, folderName)
              if (thumbPathNew) {
                db.run('UPDATE photo_versions SET thumbnail_path = ? WHERE id = ?', [thumbPathNew, vid])
                regenerated++
              }
            } catch (err) {
              console.error('[Background] Thumbnail gen failed for', vid, err)
            }
          }
        }
        if (regenerated > 0) {
          const { persistDatabase } = await import('./db/connection')
          db.run(`
            UPDATE photos SET thumbnail_path = (
              SELECT v.thumbnail_path FROM photo_versions v
              WHERE v.photo_id = photos.id AND v.thumbnail_path IS NOT NULL AND v.thumbnail_path != ''
              ORDER BY v.is_original DESC, v.created_at ASC LIMIT 1
            )
          `)
          persistDatabase()
          console.log('[Background] Regenerated', regenerated, 'missing thumbnails')
          // Notify renderer to refresh — safe because photos:listByEvent no longer triggers repair
          const wins = BrowserWindow.getAllWindows()
          if (wins.length > 0) {
            wins[0].webContents.send('photos:thumbnails-repaired', '__all__')
          }
        }
      }
    } catch (err) {
      console.error('[Background] Thumbnail regeneration failed:', err)
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
          console.log('[Background] Created', created, 'default versions for existing photos')
        }
      }
    } catch (err) {
      console.error('[Background] Version migration failed:', err)
    }
  }, 0)

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

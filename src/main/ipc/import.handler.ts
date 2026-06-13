import { ipcMain, dialog, BrowserWindow } from 'electron'
import { getDb, persistDatabase } from '../db/connection'
import { parseMetadataBatch } from '../services/metadata.service'
import { batchGenerateThumbnails } from '../services/thumbnail.service'
import { getEventDir } from '../services/library.service'
import { getEventFolderName, syncEventJsonPhotos } from './event.handler'
import { v4 as uuid } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif',
  '.heic', '.heif', '.avif', '.raw', '.cr2', '.cr3', '.nef', '.arw',
  '.dng', '.orf', '.rw2',
])

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

function scanDirectory(dirPath: string): string[] {
  const results: string[] = []
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        results.push(...scanDirectory(fullPath))
      } else if (isImageFile(fullPath)) {
        results.push(fullPath)
      }
    }
  } catch (err) {
    console.error(`Error scanning directory ${dirPath}:`, err)
  }
  return results
}

interface PreviewFileInfo {
  path: string
  name: string
  size: number
  ext: string
}

export function registerImportHandlers(): void {
  ipcMain.handle('import:selectFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择照片文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('import:selectFiles', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['multiSelections'],
      filters: [
        { name: '图片', extensions: ['jpg','jpeg','png','gif','bmp','webp','tiff','tif','heic','heif','avif','raw','cr2','cr3','nef','arw','dng','orf','rw2'] },
      ],
      title: '选择照片文件',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  ipcMain.handle('import:scanFolder', async (_event, folderPath: string): Promise<PreviewFileInfo[]> => {
    const files = scanDirectory(folderPath)
    return files.map((f) => ({
      path: f,
      name: path.basename(f),
      size: fs.statSync(f).size,
      ext: path.extname(f).toLowerCase(),
    }))
  })

  ipcMain.handle('import:preview', async (_event, filePaths: string[]): Promise<PreviewFileInfo[]> => {
    return filePaths
      .filter((fp) => fs.existsSync(fp) && isImageFile(fp))
      .map((fp) => {
        const stats = fs.statSync(fp)
        return { path: fp, name: path.basename(fp), size: stats.size, ext: path.extname(fp).toLowerCase() }
      })
  })

  ipcMain.handle(
    'import:execute',
    async (_event, data: { eventId: string; filePaths: string[] }): Promise<{ imported: number; skipped: number; errors: string[]; errorDetails?: string[]; totalError?: string }> => {
      let db = getDb()
      const now = new Date().toISOString()
      let imported = 0
      let skipped = 0
      const errors: string[] = []
      const errorDetails: string[] = []

      try {
        // Get human-readable folder name for this event
        const folderName = getEventFolderName(data.eventId)
        const eventDir = getEventDir(folderName)
        fs.mkdirSync(eventDir, { recursive: true })

        const metadataMap = await parseMetadataBatch(data.filePaths)

        // First pass: copy files and insert into DB
        const photoIds: string[] = []
        const sourcePaths: string[] = []

        for (const srcPath of data.filePaths) {
          try {
            const fileName = path.basename(srcPath)
            const destPath = path.join(eventDir, fileName)

            const existing = db.exec('SELECT id FROM photos WHERE file_path = ?', [destPath])
            if (existing.length > 0 && existing[0].values.length > 0) {
              skipped++
              continue
            }

            fs.copyFileSync(srcPath, destPath)
            const stats = fs.statSync(destPath)
            const meta = metadataMap.get(srcPath)
            const id = uuid()

            // Convert dateTimeOriginal to ISO string if it's a Date object (exifr returns Date)
            const dateOriginal = meta?.dateTimeOriginal
              ? (typeof meta.dateTimeOriginal === 'string' ? meta.dateTimeOriginal : new Date(meta.dateTimeOriginal).toISOString())
              : now

            db.run(
              `INSERT INTO photos (id, event_id, file_path, file_name, file_size, width, height, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [id, data.eventId, destPath, fileName, stats.size, meta?.imageWidth || 0, meta?.imageHeight || 0, meta && Object.keys(meta).length > 0 ? JSON.stringify(meta) : null, dateOriginal, now]
            )
            photoIds.push(id)
            sourcePaths.push(destPath)
            imported++
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.error(`[Import] Failed to import ${path.basename(srcPath)}:`, errMsg)
            errors.push(path.basename(srcPath))
            errorDetails.push(`${path.basename(srcPath)}: ${errMsg}`)
          }
        }

        // Second pass: generate thumbnails
        if (photoIds.length > 0) {
          try {
            const thumbFiles = photoIds.map((photoId, i) => ({
              sourcePath: sourcePaths[i],
              photoId,
            }))
            const thumbnails = await batchGenerateThumbnails(thumbFiles, data.eventId, folderName)

            // Update thumbnail paths in DB
            for (const [photoId, thumbPath] of thumbnails) {
              if (thumbPath) {
                db.run('UPDATE photos SET thumbnail_path = ? WHERE id = ?', [thumbPath, photoId])
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.error('[Import] Thumbnail generation failed:', errMsg)
            // Non-fatal: thumbnails missing won't crash the app
          }
        }

        db.run('UPDATE events SET updated_at = ? WHERE id = ?', [now, data.eventId])
        persistDatabase()
        syncEventJsonPhotos(data.eventId)
        return { imported, skipped, errors, errorDetails }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error('[Import] Fatal error during import:', errMsg)
        return { imported, skipped, errors, errorDetails, totalError: errMsg }
      }
    }
  )
}
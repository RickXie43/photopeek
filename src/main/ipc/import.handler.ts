import { ipcMain, dialog, BrowserWindow } from 'electron'
import { getDb, persistDatabase } from '../db/connection'
import { parseMetadataBatch } from '../services/metadata.service'
import { generateThumbnail } from '../services/thumbnail.service'
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

// File type priority (lower number = higher priority = becomes is_original)
// JPEG first — it's faster to display, then RAW/DNG for originals
const FILE_TYPE_PRIORITY: Record<string, number> = {
  '.jpg': 1, '.jpeg': 1,
  '.png': 2,
  '.heic': 3, '.heif': 3,
  '.tiff': 4, '.tif': 4,
  '.dng': 5,
  '.raw': 6, '.cr2': 6, '.cr3': 6, '.nef': 6, '.arw': 6,
  '.rw2': 6, '.orf': 6, '.raf': 6, '.srf': 6, '.sr2': 6,
  '.avif': 7,
  '.gif': 8, '.bmp': 8, '.webp': 8,
}

const RAW_EXTENSIONS = new Set(['.raw', '.cr2', '.cr3', '.nef', '.arw', '.rw2', '.orf', '.raf', '.srf', '.sr2'])

function getVersionName(ext: string): string {
  const e = ext.toLowerCase()
  if (RAW_EXTENSIONS.has(e)) return 'RAW'
  if (e === '.dng') return 'DNG'
  if (e === '.jpg' || e === '.jpeg') return 'JPEG'
  if (e === '.png') return 'PNG'
  if (e === '.heic' || e === '.heif') return 'HEIC'
  if (e === '.tiff' || e === '.tif') return 'TIFF'
  if (e === '.avif') return 'AVIF'
  return '原始文件'
}

function getFilePriority(ext: string): number {
  return FILE_TYPE_PRIORITY[ext.toLowerCase()] || 99
}

function getBaseName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName))
}

/** Build a match key for grouping photos: dateTimeOriginal + base file name */
function buildMatchKey(dateTimeOriginal: string | null | undefined, baseName: string): string {
  return (dateTimeOriginal || '') + '|' + baseName.toLowerCase()
}

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

/** Insert a new photo_versions record and generate its thumbnail */
async function insertVersion(
  db: ReturnType<typeof getDb>,
  photoId: string,
  versionName: string,
  filePath: string,
  fileName: string,
  fileSize: number,
  width: number,
  height: number,
  metadata: string | null,
  isOriginal: boolean,
  uploadedBy: string | null,
  createdAt: string,
  eventId: string,
  folderName: string,
): Promise<string> {
  const versionId = uuid()
  db.run(
    `INSERT INTO photo_versions (id, photo_id, version_name, file_path, file_name, file_size, width, height, metadata, is_original, uploaded_by, uploaded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [versionId, photoId, versionName, filePath, fileName, fileSize, width, height, metadata, isOriginal ? 1 : 0, uploadedBy, isOriginal ? createdAt : null, createdAt],
  )

  // Generate thumbnail for this version
  try {
    const thumbPath = await generateThumbnail(filePath, versionId, eventId, folderName)
    if (thumbPath) {
      db.run('UPDATE photo_versions SET thumbnail_path = ? WHERE id = ?', [thumbPath, versionId])
    }
  } catch (err) {
    console.error(`[Import] Thumbnail generation failed for version ${versionName}:`, err)
  }

  return versionId
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

  interface ImportFileInfo {
    srcPath: string
    destPath: string
    fileName: string
    ext: string
    size: number
    meta: Record<string, unknown> | null | undefined
    dateTimeOriginal: string | null
    matchKey: string
    baseName: string
    priority: number
  }

  ipcMain.handle(
    'import:execute',
    async (_event, data: { eventId: string; filePaths: string[] }): Promise<{
      imported: number; skipped: number; errors: string[]; errorDetails?: string[]; totalError?: string
      merged: number  // ← new: count of files merged as versions into existing photos
    }> => {
      let db = getDb()
      const now = new Date().toISOString()
      let imported = 0
      let skipped = 0
      let merged = 0
      const errors: string[] = []
      const errorDetails: string[] = []

      try {
        const folderName = getEventFolderName(data.eventId)
        const eventDir = getEventDir(folderName)
        fs.mkdirSync(eventDir, { recursive: true })

        // Step 1: Parse metadata and copy files
        const metadataMap = await parseMetadataBatch(data.filePaths)
        const fileInfos: ImportFileInfo[] = []

        for (const srcPath of data.filePaths) {
          try {
            const fileName = path.basename(srcPath)
            const destPath = path.join(eventDir, fileName)
            const ext = path.extname(fileName).toLowerCase()

            // Check if a photo with this file_path already exists (including trashed)
            const existingAny = db.exec('SELECT id, deleted_at FROM photos WHERE file_path = ?', [destPath])
            if (existingAny.length > 0 && existingAny[0].values.length > 0) {
              const row = existingAny[0].values[0]
              const existingPhotoId = row[0] as string
              const isDeleted = row[1] !== null
              if (isDeleted) {
                // Permanently delete the trashed record so we can reuse the file_path
                db.run('DELETE FROM photo_versions WHERE photo_id = ?', [existingPhotoId])
                db.run('DELETE FROM photos WHERE id = ?', [existingPhotoId])
              } else {
                // Active photo — try to add as version if not duplicate
                const verExisting = db.exec(
                  'SELECT id FROM photo_versions WHERE photo_id = ? AND file_name = ?',
                  [existingPhotoId, fileName],
                )
                if (verExisting.length > 0 && verExisting[0].values.length > 0) {
                  skipped++
                  continue
                }
              }
            }

            fs.copyFileSync(srcPath, destPath)
            const stats = fs.statSync(destPath)
            const meta = metadataMap.get(srcPath)

            const dateTimeOriginal = meta?.dateTimeOriginal
              ? (typeof meta.dateTimeOriginal === 'string' ? meta.dateTimeOriginal : new Date(meta.dateTimeOriginal as Date).toISOString())
              : null

            const baseName = getBaseName(fileName)
            fileInfos.push({
              srcPath,
              destPath,
              fileName,
              ext,
              size: stats.size,
              meta,
              dateTimeOriginal,
              matchKey: buildMatchKey(dateTimeOriginal, baseName),
              baseName,
              priority: getFilePriority(ext),
            })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.error(`[Import] Failed to prepare ${path.basename(srcPath)}:`, errMsg)
            errors.push(path.basename(srcPath))
            errorDetails.push(`${path.basename(srcPath)}: ${errMsg}`)
          }
        }

        // Step 2: Build batch-group lookup (files within same import that share a matchKey)
        const batchGroupMap = new Map<string, ImportFileInfo[]>()
        for (const info of fileInfos) {
          if (!info.matchKey) continue
          const group = batchGroupMap.get(info.matchKey) || []
          group.push(info)
          batchGroupMap.set(info.matchKey, group)
        }

        // Step 3: Load existing photos in this event for cross-session matching
        const existingPhotoRows = db.exec(
          'SELECT id, file_name, metadata, file_path FROM photos WHERE event_id = ? AND deleted_at IS NULL',
          [data.eventId],
        )
        const existingLookup = new Map<string, { photoId: string; fileName: string; filePath: string }>()
        if (existingPhotoRows.length > 0) {
          const { columns, values } = existingPhotoRows[0]
          for (const row of values) {
            const rowObj = Object.fromEntries(columns.map((c, i) => [c, row[i]]))
            const photoId = rowObj.id as string
            const fileName = rowObj.file_name as string
            const filePath = rowObj.file_path as string
            const metaStr = rowObj.metadata as string | null
            let dateTimeOriginal: string | null = null
            if (metaStr) {
              try {
                const parsed = JSON.parse(metaStr)
                dateTimeOriginal = parsed.dateTimeOriginal || null
              } catch {}
            }
            const baseName = getBaseName(fileName)
            const key = buildMatchKey(dateTimeOriginal, baseName)
            if (key !== '|') {  // skip files with neither dateTimeOriginal nor basename
              existingLookup.set(key, { photoId, fileName, filePath })
            }
          }
        }

        // Step 4: Process each file — create photo + version or add version to existing
        // photoIdByKey tracks which photoId was created for each matchKey across this batch
        const photoIdByKey = new Map<string, string>()

        for (const info of fileInfos) {
          try {
            const key = info.matchKey
            let targetPhotoId: string | null = null

            if (key && key !== '|') {
              // Check if this key was already processed within this batch
              targetPhotoId = photoIdByKey.get(key) || null

              if (!targetPhotoId) {
                // Check existing DB for cross-session match
                const existingMatch = existingLookup.get(key)
                if (existingMatch) {
                  targetPhotoId = existingMatch.photoId
                }
              }
            }

            if (!targetPhotoId) {
              // No match found — create new photo
              targetPhotoId = uuid()
              const dateOriginal = info.dateTimeOriginal || now
              const metaJson = info.meta && Object.keys(info.meta).length > 0
                ? JSON.stringify(info.meta)
                : null

              // Determine if this file should be is_original (the highest priority in this batch group)
              const group = batchGroupMap.get(key) || [info]
              const bestInGroup = group.reduce((a, b) => a.priority < b.priority ? a : b)
              const isOriginal = info.priority === bestInGroup.priority

              db.run(
                `INSERT INTO photos (id, event_id, file_path, file_name, file_size, width, height, metadata, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [targetPhotoId, data.eventId, info.destPath, info.fileName, info.size,
                 (info.meta?.imageWidth as number) || 0, (info.meta?.imageHeight as number) || 0,
                 metaJson, dateOriginal, now],
              )

              const versionName = getVersionName(info.ext)
              await insertVersion(
                db, targetPhotoId, versionName, info.destPath, info.fileName,
                info.size, (info.meta?.imageWidth as number) || 0, (info.meta?.imageHeight as number) || 0,
                metaJson, isOriginal, null, dateOriginal, data.eventId, folderName,
              )

              // Register this key so subsequent files in same batch group find it
              if (key && key !== '|') photoIdByKey.set(key, targetPhotoId)
              imported++

            } else {
              // Match found — add as version to existing photo
              const versionName = getVersionName(info.ext)

              // Check if this version type or filename already exists for this photo
              const verExisting = db.exec(
                'SELECT id FROM photo_versions WHERE photo_id = ? AND version_name = ?',
                [targetPhotoId, versionName],
              )
              const verFileExisting = db.exec(
                'SELECT id FROM photo_versions WHERE photo_id = ? AND file_name = ?',
                [targetPhotoId, info.fileName],
              )

              if (verExisting.length > 0 && verExisting[0].values.length > 0) {
                skipped++
                continue
              }
              if (verFileExisting.length > 0 && verFileExisting[0].values.length > 0) {
                skipped++
                continue
              }

              const metaJson = info.meta && Object.keys(info.meta).length > 0
                ? JSON.stringify(info.meta)
                : null

              // Check if this new file has higher priority than current is_original
              const curOrig = db.exec(
                'SELECT id, file_path FROM photo_versions WHERE photo_id = ? AND is_original = 1',
                [targetPhotoId],
              )
              const currentPriority = curOrig.length > 0 && curOrig[0].values.length > 0
                ? getFilePriority(path.extname((curOrig[0].values[0][1] as string) || ''))
                : 99

              const shouldUpgrade = info.priority < currentPriority

              if (shouldUpgrade) {
                // Demote existing original
                db.run('UPDATE photo_versions SET is_original = 0 WHERE photo_id = ? AND is_original = 1', [targetPhotoId])
                // Update photos table to point to the better file
                db.run(
                  'UPDATE photos SET file_path = ?, file_name = ?, file_size = ?, width = ?, height = ?, metadata = ?, updated_at = ? WHERE id = ?',
                  [info.destPath, info.fileName, info.size, (info.meta?.imageWidth as number) || 0,
                   (info.meta?.imageHeight as number) || 0, metaJson, now, targetPhotoId],
                )
              }

              const isOriginal = shouldUpgrade
              await insertVersion(
                db, targetPhotoId, versionName, info.destPath, info.fileName,
                info.size, (info.meta?.imageWidth as number) || 0, (info.meta?.imageHeight as number) || 0,
                metaJson, isOriginal, null, info.dateTimeOriginal || now, data.eventId, folderName,
              )

              merged++
              imported++
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.error(`[Import] Failed to process ${info.fileName}:`, errMsg)
            errors.push(info.fileName)
            errorDetails.push(`${info.fileName}: ${errMsg}`)
          }
        }

        // Sync photos.thumbnail_path to the best available version's thumbnail
        syncPhotoThumbnailPaths(db)

        db.run('UPDATE events SET updated_at = ? WHERE id = ?', [now, data.eventId])
        persistDatabase()
        syncEventJsonPhotos(data.eventId)
        console.log(`[Import] Done: ${imported} imported (${merged} merged), ${skipped} skipped, ${errors.length} errors`)
        return { imported, skipped, errors, errorDetails, merged }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error('[Import] Fatal error during import:', errMsg)
        return { imported, skipped, errors, errorDetails, totalError: errMsg, merged: 0 }
      }
    }
  )
}

/** Sync photos.thumbnail_path to the highest-priority version's thumbnail */
function syncPhotoThumbnailPaths(db: ReturnType<typeof getDb>): void {
  const vRows = db.exec(`
    SELECT v.photo_id, v.thumbnail_path
    FROM photo_versions v
    WHERE v.thumbnail_path IS NOT NULL AND v.thumbnail_path != ''
      AND (v.is_original = 1 OR NOT EXISTS (
        SELECT 1 FROM photo_versions v2
        WHERE v2.photo_id = v.photo_id AND v2.is_original = 1 AND v2.thumbnail_path IS NOT NULL AND v2.thumbnail_path != ''
      ))
    ORDER BY v.is_original DESC
  `)
  if (vRows.length === 0) return
  const { columns, values } = vRows[0]
  const photoIds = new Set<string>()
  for (const row of values) {
    const photoId = row[columns.indexOf('photo_id')] as string
    const thumbPath = row[columns.indexOf('thumbnail_path')] as string
    if (!photoIds.has(photoId) && thumbPath) {
      db.run('UPDATE photos SET thumbnail_path = ? WHERE id = ?', [thumbPath, photoId])
      photoIds.add(photoId)
    }
  }
}
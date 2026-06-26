import { ipcMain, dialog, BrowserWindow } from 'electron'
import { getDb, persistDatabase } from '../db/connection'
import { parseMetadataBatch } from '../services/metadata.service'
import { generateThumbnail } from '../services/thumbnail.service'
import { getEventDir } from '../services/library.service'
import { getEventFolderName, syncEventJsonPhotos } from './event.handler'
import { v4 as uuid } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import sharp from 'sharp'

// --- dHash (差异哈希) for perceptual image matching ---
const DHASH_THRESHOLD = 12

async function computeDHash(filePath: string): Promise<string> {
  const pixels = await sharp(filePath)
    .rotate()
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer()
  let hash = ''
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash += pixels[y * 9 + x]! < pixels[y * 9 + x + 1]! ? '1' : '0'
    }
  }
  return hash
}

function hammingDistance(a: string, b: string): number {
  let dist = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++
  return dist
}

function findBestDHashMatch(
  targetHash: string,
  existingHashes: Map<string, string>,
): { photoId: string; distance: number } | null {
  let best: { photoId: string; distance: number } | null = null
  for (const [photoId, hash] of existingHashes) {
    const dist = hammingDistance(targetHash, hash)
    if (dist <= DHASH_THRESHOLD && (!best || dist < best.distance)) {
      best = { photoId, distance: dist }
    }
  }
  return best
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

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
      if (entry.isFile() && isImageFile(entry.name)) {
        results.push(path.join(dirPath, entry.name))
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

  // Compute dHash and embed it in metadata for perceptual matching
  let finalMetadata = metadata
  try {
    const dHash = await computeDHash(filePath)
    const metaObj: Record<string, unknown> = metadata ? JSON.parse(metadata) : {}
    metaObj._dHash = dHash
    finalMetadata = JSON.stringify(metaObj)
  } catch (err) {
    console.warn(`[Import] dHash computation failed for ${fileName}:`, err)
  }

  db.run(
    `INSERT INTO photo_versions (id, photo_id, version_name, file_path, file_name, file_size, width, height, metadata, is_original, uploaded_by, uploaded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [versionId, photoId, versionName, filePath, fileName, fileSize, width, height, finalMetadata, isOriginal ? 1 : 0, uploadedBy, (isOriginal || uploadedBy) ? createdAt : null, createdAt],
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
    dHash: string
  }

  // --- Cancellation state ---
  let importCancelled = false

  ipcMain.on('import:cancel', () => {
    importCancelled = true
  })

  // --- Progress helper ---
  function sendProgress(db: ReturnType<typeof getDb>, phase: string, current: number, total: number, message: string): void {
    // Weight: metadata 25%, processing 75%
    const percent = phase === 'metadata'
      ? Math.round((current / Math.max(total, 1)) * 25)
      : 25 + Math.round((current / Math.max(total, 1)) * 75)
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.webContents.send('import:progress', { phase, current, total, message, percent })
    }
  }

  ipcMain.handle(
    'import:execute',
    async (_event, data: { eventId: string; filePaths: string[]; importMode?: 'original' | 'retouched'; versionName?: string }): Promise<{
      imported: number; skipped: number; errors: string[]; errorDetails?: string[]; totalError?: string
      merged: number
    }> => {
      importCancelled = false
      let db = getDb()
      const now = new Date().toISOString()
      let imported = 0
      let skipped = 0
      let merged = 0
      const errors: string[] = []
      const errorDetails: string[] = []
      const copiedFiles: string[] = []
      const createdPhotoIds: string[] = []

      try {
        const isRetouched = data.importMode === 'retouched' && data.versionName
        const folderName = getEventFolderName(data.eventId)
        const eventDir = getEventDir(folderName)
        fs.mkdirSync(eventDir, { recursive: true })

        const totalCount = data.filePaths.length

        // --- Resolve version name for retouched mode BEFORE file copy ---
        let resolvedVersionName = data.versionName || '修图版本'
        if (isRetouched) {
          const existingVersions = db.exec(
            `SELECT DISTINCT v.version_name FROM photo_versions v
             JOIN photos p ON v.photo_id = p.id
             WHERE p.event_id = ? AND v.uploaded_by = ?`,
            [data.eventId, resolvedVersionName],
          )
          const existingNames: string[] = []
          if (existingVersions.length > 0 && existingVersions[0].values.length > 0) {
            for (const row of existingVersions[0].values) {
              existingNames.push(row[0] as string)
            }
          }
          const prefix = resolvedVersionName + ' · '
          const pattern = new RegExp('^' + escapeRegex(resolvedVersionName) + ' · (\\d+)$')
          let maxNum = 0
          for (const vn of existingNames) {
            if (vn === resolvedVersionName) maxNum = Math.max(maxNum, 1)
            const match = vn.match(pattern)
            if (match) maxNum = Math.max(maxNum, parseInt(match[1]!, 10))
          }
          resolvedVersionName = maxNum === 0 ? resolvedVersionName + ' · 1' : resolvedVersionName + ' · ' + (maxNum + 1)
        }

        // Step 1: Parse metadata batch with progress
        sendProgress(db, 'metadata', 0, totalCount, '解析元数据...')
        const metadataMap = await parseMetadataBatch(data.filePaths)
        sendProgress(db, 'metadata', totalCount, totalCount, '解析元数据完成')

        if (importCancelled) {
          return { imported: 0, skipped: 0, errors: [], merged: 0 }
        }

        const fileInfos: ImportFileInfo[] = []
        let processedCount = 0

        for (const srcPath of data.filePaths) {
          if (importCancelled) {
            for (const f of copiedFiles) { try { fs.unlinkSync(f) } catch {} }
            for (const photoId of createdPhotoIds) {
              db.run('DELETE FROM photo_versions WHERE photo_id = ?', [photoId])
              db.run('DELETE FROM photos WHERE id = ?', [photoId])
            }
            persistDatabase()
            return { imported, skipped, errors, merged }
          }

          try {
            const origFileName = path.basename(srcPath)
            let fileName = origFileName
            const ext = path.extname(fileName).toLowerCase()
            const baseName = getBaseName(fileName)

            // Resolve destination filename for retouched mode
            if (isRetouched) {
              const versionKey = resolvedVersionName.replace(/ · /g, '_')
              fileName = baseName + '_' + versionKey + ext
            }

            let destPath = path.join(eventDir, fileName)

            // Ensure unique filename on disk
            if (fs.existsSync(destPath)) {
              let counter = 1
              const nameNoExt = path.basename(fileName, ext)
              while (fs.existsSync(destPath)) {
                fileName = nameNoExt + '_' + counter + ext
                destPath = path.join(eventDir, fileName)
                counter++
              }
            }

            // Check if a photo with this file_path already exists (including trashed)
            if (!isRetouched) {
              const existingAny = db.exec('SELECT id, deleted_at FROM photos WHERE file_path = ?', [destPath])
              if (existingAny.length > 0 && existingAny[0].values.length > 0) {
                const row = existingAny[0].values[0]
                const existingPhotoId = row[0] as string
                const isDeleted = row[1] !== null
                if (isDeleted) {
                  db.run('DELETE FROM photo_versions WHERE photo_id = ?', [existingPhotoId])
                  db.run('DELETE FROM photos WHERE id = ?', [existingPhotoId])
                } else {
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
            }

            fs.copyFileSync(srcPath, destPath)
            copiedFiles.push(destPath)
            const stats = fs.statSync(destPath)
            const meta = metadataMap.get(srcPath)

            const dateTimeOriginal = meta?.dateTimeOriginal
              ? (typeof meta.dateTimeOriginal === 'string' ? meta.dateTimeOriginal : new Date(meta.dateTimeOriginal as Date).toISOString())
              : null

            // Compute dHash for perceptual matching
            let dHash = ''
            try {
              dHash = await computeDHash(destPath)
            } catch {
              // non-fatal
            }

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
              dHash,
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
        const existingByBaseName = new Map<string, { photoId: string }[]>()
        const existingDHashMap = new Map<string, string>()
        const existingRetouchedPhotoIds = new Set<string>()

        if (existingPhotoRows.length > 0) {
          const { columns, values } = existingPhotoRows[0]
          for (const row of values) {
            const rowObj = Object.fromEntries(columns.map((c, i) => [c, row[i]]))
            const photoId = rowObj.id as string
            const fileName = rowObj.file_name as string
            const filePath = rowObj.file_path as string
            const metaStr = rowObj.metadata as string | null

            // Build basename index
            const bn = getBaseName(fileName)
            if (!existingByBaseName.has(bn)) existingByBaseName.set(bn, [])
            existingByBaseName.get(bn)!.push({ photoId })

            // Check if this photo has retouched versions
            const hasRetouched = db.exec(
              'SELECT 1 FROM photo_versions WHERE photo_id = ? AND uploaded_by IS NOT NULL',
              [photoId],
            )
            if (hasRetouched.length > 0 && hasRetouched[0].values.length > 0) {
              existingRetouchedPhotoIds.add(photoId)
            }

            // Load dHash from metadata, or compute and backfill
            let dateTimeOriginal: string | null = null
            let dHash = ''
            if (metaStr) {
              try {
                const parsed = JSON.parse(metaStr)
                dateTimeOriginal = parsed.dateTimeOriginal || null
                dHash = parsed._dHash || ''
              } catch {}
            }
            if (!dHash) {
              try {
                dHash = await computeDHash(filePath)
                const meta = metaStr ? JSON.parse(metaStr) : {}
                meta._dHash = dHash
                db.run('UPDATE photos SET metadata = ? WHERE id = ?', [JSON.stringify(meta), photoId])
              } catch {
                // non-fatal, just skip dHash matching for this photo
              }
            }
            if (dHash) {
              existingDHashMap.set(photoId, dHash)
            }

            const baseName = getBaseName(fileName)
            const key = buildMatchKey(dateTimeOriginal, baseName)
            if (key !== '|') {
              existingLookup.set(key, { photoId, fileName, filePath })
            }
          }
        }

        // Step 4: Process each file — create photo + version or add version to existing
        const photoIdByKey = new Map<string, string>()
        let step4Count = 0
        const step4Total = fileInfos.length

        for (const info of fileInfos) {
          if (importCancelled) {
            for (const f of copiedFiles) { try { fs.unlinkSync(f) } catch {} }
            for (const photoId of createdPhotoIds) {
              db.run('DELETE FROM photo_versions WHERE photo_id = ?', [photoId])
              db.run('DELETE FROM photos WHERE id = ?', [photoId])
            }
            persistDatabase()
            return { imported, skipped, errors, merged }
          }

          step4Count++
          sendProgress(db, 'processing', step4Count, step4Total, '导入 ' + info.fileName + '...')

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

            // --- Multi-layer fallback matching for retouched mode ---
            if (!targetPhotoId && isRetouched) {
              // L2: basename match
              const bnMatches = existingByBaseName.get(info.baseName)
              if (bnMatches && bnMatches.length > 0) {
                targetPhotoId = bnMatches[0]!.photoId
              }
            }
            if (!targetPhotoId && isRetouched) {
              // L3: substring match (one filename contains the other)
              for (const [bn, entries] of existingByBaseName) {
                if (info.baseName.includes(bn) || bn.includes(info.baseName)) {
                  targetPhotoId = entries[0]!.photoId
                  break
                }
              }
            }
            if (!targetPhotoId && isRetouched && info.dHash) {
              // L4: dHash perceptual match
              const match = findBestDHashMatch(info.dHash, existingDHashMap)
              if (match) targetPhotoId = match.photoId
            }

            // --- Reverse match for original mode: try to match against retouched photos ---
            if (!targetPhotoId && !isRetouched && info.dHash) {
              const match = findBestDHashMatch(info.dHash, existingDHashMap)
              if (match) {
                // Found a retouched version — attach original to that photo as is_original=1
                targetPhotoId = match.photoId
                // Demote any existing is_original
                db.run('UPDATE photo_versions SET is_original = 0 WHERE photo_id = ? AND is_original = 1', [targetPhotoId])
                // Update photos metadata to point to original file
                db.run(
                  'UPDATE photos SET file_path = ?, file_name = ?, file_size = ?, width = ?, height = ?, updated_at = ? WHERE id = ?',
                  [info.destPath, info.fileName, info.size, (info.meta?.imageWidth as number) || 0,
                   (info.meta?.imageHeight as number) || 0, now, targetPhotoId],
                )
              }
            }

            if (!targetPhotoId) {
              // No match found — create new photo
              targetPhotoId = uuid()
              createdPhotoIds.push(targetPhotoId)
              const dateOriginal = info.dateTimeOriginal || now
              const metaJson = info.meta && Object.keys(info.meta).length > 0
                ? JSON.stringify(info.meta)
                : null

              // Determine if this file should be is_original
              let isOriginal: boolean
              if (isRetouched) {
                isOriginal = false
              } else {
                const group = batchGroupMap.get(key) || [info]
                const bestInGroup = group.reduce((a, b) => a.priority < b.priority ? a : b)
                isOriginal = info.priority === bestInGroup.priority
              }

              db.run(
                `INSERT INTO photos (id, event_id, file_path, file_name, file_size, width, height, metadata, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [targetPhotoId, data.eventId, info.destPath, info.fileName, info.size,
                 (info.meta?.imageWidth as number) || 0, (info.meta?.imageHeight as number) || 0,
                 metaJson, dateOriginal, now],
              )

              const versionName = isRetouched ? resolvedVersionName : getVersionName(info.ext)
              const uploadedBy = isRetouched ? data.versionName || null : null
              await insertVersion(
                db, targetPhotoId, versionName, info.destPath, info.fileName,
                info.size, (info.meta?.imageWidth as number) || 0, (info.meta?.imageHeight as number) || 0,
                metaJson, isOriginal, uploadedBy, dateOriginal, data.eventId, folderName,
              )

              if (key && key !== '|') photoIdByKey.set(key, targetPhotoId)
              imported++

            } else {
              // Match found — add as version to existing photo
              let versionName: string
              let uploadedBy: string | null
              let isOriginal: boolean

              if (isRetouched) {
                versionName = resolvedVersionName
                uploadedBy = data.versionName || null
                isOriginal = false
              } else {
                versionName = getVersionName(info.ext)
                uploadedBy = null

                // Check priority vs current original
                const curOrig = db.exec(
                  'SELECT id, file_path FROM photo_versions WHERE photo_id = ? AND is_original = 1',
                  [targetPhotoId],
                )
                const currentPriority = curOrig.length > 0 && curOrig[0].values.length > 0
                  ? getFilePriority(path.extname((curOrig[0].values[0][1] as string) || ''))
                  : 99
                isOriginal = info.priority < currentPriority
              }

              // Duplicate check: for original mode, skip same version_name or file_name
              if (!isRetouched) {
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
              } else {
                // For retouched mode, only skip if same version_name (different files ok)
                const verExisting = db.exec(
                  'SELECT id FROM photo_versions WHERE photo_id = ? AND version_name = ?',
                  [targetPhotoId, versionName],
                )
                if (verExisting.length > 0 && verExisting[0].values.length > 0) {
                  skipped++
                  continue
                }
              }

              const metaJson = info.meta && Object.keys(info.meta).length > 0
                ? JSON.stringify(info.meta)
                : null

              if (!isRetouched && isOriginal) {
                // Demote existing original
                db.run('UPDATE photo_versions SET is_original = 0 WHERE photo_id = ? AND is_original = 1', [targetPhotoId])
                db.run(
                  'UPDATE photos SET file_path = ?, file_name = ?, file_size = ?, width = ?, height = ?, metadata = ?, updated_at = ? WHERE id = ?',
                  [info.destPath, info.fileName, info.size, (info.meta?.imageWidth as number) || 0,
                   (info.meta?.imageHeight as number) || 0, metaJson, now, targetPhotoId],
                )
              }

              await insertVersion(
                db, targetPhotoId, versionName, info.destPath, info.fileName,
                info.size, (info.meta?.imageWidth as number) || 0, (info.meta?.imageHeight as number) || 0,
                metaJson, isOriginal, uploadedBy, info.dateTimeOriginal || now, data.eventId, folderName,
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
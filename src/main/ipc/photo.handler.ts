import { ipcMain } from 'electron'
import { getDb, persistDatabase } from '../db/connection'
import type { Photo, PhotoVersion } from '../../renderer/src/types/photo'
import { syncEventJsonPhotos, getEventFolderName } from './event.handler'
import { getEventDir } from '../services/library.service'
import { parseMetadata } from '../services/metadata.service'
import { v4 as uuid } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import sharp from 'sharp'

function queryAll(db: ReturnType<typeof getDb>, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const rows = db.exec(sql, params)
  if (rows.length === 0) return []
  const { columns, values } = rows[0]
  return values.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])) as Record<string, unknown>)
}

function queryOne(db: ReturnType<typeof getDb>, sql: string, params: unknown[] = []): Record<string, unknown> | null {
  const rows = db.exec(sql, params)
  if (rows.length === 0 || rows[0].values.length === 0) return null
  const { columns, values } = rows[0]
  return Object.fromEntries(columns.map((col, i) => [col, values[0][i]])) as Record<string, unknown>
}

function deserializePhoto(row: Record<string, unknown>): Photo {
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    filePath: row.file_path as string,
    fileName: row.file_name as string,
    fileSize: row.file_size as number,
    width: row.width as number,
    height: row.height as number,
    rating: row.rating as number,
    flag: (row.flag as 'pick' | 'reject' | null) || null,
    colorLabel: (row.color_label as Photo['colorLabel']) || null,
    isEdited: (row.is_edited as number) === 1,
    needsEdit: (row.needs_edit as number) === 1,
    thumbnailPath: (row.thumbnail_path as string) || null,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    originalMetadata: row.original_metadata ? JSON.parse(row.original_metadata as string) : null,
    deletedAt: (row.deleted_at as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    versionSummary: (row.version_summary as string) || null,
  }
}

/** Attach version summary string to each photo (for GridView badges) */
export function attachVersionSummary(db: ReturnType<typeof getDb>, photos: Photo[]): void {
  if (photos.length === 0) return
  const ids = photos.map(p => p.id)
  // sql.js doesn't have GROUP_CONCAT, so we query all versions and build the map in JS
  const placeholders = ids.map(() => '?').join(',')
  const vRows = db.exec(
    `SELECT photo_id, version_name FROM photo_versions WHERE photo_id IN (${placeholders}) ORDER BY photo_id, is_original DESC, created_at ASC`,
    ids,
  )
  if (vRows.length === 0) return
  const summaryMap = new Map<string, string[]>()
  const { columns, values } = vRows[0]
  for (const row of values) {
    const pid = row[columns.indexOf('photo_id')] as string
    const vn = row[columns.indexOf('version_name')] as string
    if (!summaryMap.has(pid)) summaryMap.set(pid, [])
    summaryMap.get(pid)!.push(vn)
  }
  for (const photo of photos) {
    const versions = summaryMap.get(photo.id)
    if (versions && versions.length > 0) {
      photo.versionSummary = JSON.stringify(versions)
    }
  }
}

/**
 * Repair photos that have 0×0 dimensions by reading actual dimensions from the file using sharp.
 * This fixes existing photos imported before the metadata parsing was fixed.
 */
async function repairZeroDimensions(db: ReturnType<typeof getDb>, photos: Record<string, unknown>[]): Promise<void> {
  const now = new Date().toISOString()
  let repaired = 0
  for (const row of photos) {
    const w = row.width as number
    const h = row.height as number
    if ((!w || w === 0) || (!h || h === 0)) {
      const filePath = row.file_path as string
      if (filePath && fs.existsSync(filePath)) {
        try {
          const meta = await sharp(filePath).metadata()
          let updated = false
          if (meta.width && meta.width > 0) {
            db.run('UPDATE photos SET width = ?, updated_at = ? WHERE id = ?', [meta.width, now, row.id])
            row.width = meta.width
            updated = true
          }
          if (meta.height && meta.height > 0) {
            db.run('UPDATE photos SET height = ?, updated_at = ? WHERE id = ?', [meta.height, now, row.id])
            row.height = meta.height
            updated = true
          }
          if (updated) {
            repaired++
            // Also update metadata JSON if width/height missing there
            if (row.metadata) {
              try {
                const md = JSON.parse(row.metadata as string)
                if (!md.imageWidth && meta.width) md.imageWidth = meta.width
                if (!md.imageHeight && meta.height) md.imageHeight = meta.height
                db.run('UPDATE photos SET metadata = ? WHERE id = ?', [JSON.stringify(md), row.id])
              } catch {}
            }
          }
        } catch {}
      }
    }
  }
  if (repaired > 0) {
    persistDatabase()
    console.log('[Photo] Repaired dimensions for', repaired, 'photos')
  }
}

/** Re-parse metadata for photos that have null/incomplete metadata (from old broken parser) */
async function repairMetadata(db: ReturnType<typeof getDb>, photos: Record<string, unknown>[]): Promise<void> {
  const now = new Date().toISOString()
  let repaired = 0
  for (const row of photos) {
    const filePath = row.file_path as string
    // Skip if metadata already has useful fields
    if (row.metadata) {
      try {
        const md = JSON.parse(row.metadata as string)
        if (md && (md.cameraModel || md.dateTimeOriginal || md.iso)) continue
      } catch {}
    }
    if (!filePath || !fs.existsSync(filePath)) continue
    try {
      const newMeta = await parseMetadata(filePath)
      if (newMeta && Object.keys(newMeta).length > 0) {
        const metaJson = JSON.stringify(newMeta)
        db.run('UPDATE photos SET metadata = ?, updated_at = ? WHERE id = ?', [metaJson, now, row.id])
        row.metadata = metaJson
        // Also update dimensions if needed
        if (newMeta.imageWidth && newMeta.imageWidth > 0 && (!row.width || row.width === 0)) {
          db.run('UPDATE photos SET width = ? WHERE id = ?', [newMeta.imageWidth, row.id])
          row.width = newMeta.imageWidth
        }
        if (newMeta.imageHeight && newMeta.imageHeight > 0 && (!row.height || row.height === 0)) {
          db.run('UPDATE photos SET height = ? WHERE id = ?', [newMeta.imageHeight, row.id])
          row.height = newMeta.imageHeight
        }
        repaired++
      }
    } catch {}
  }
  if (repaired > 0) {
    persistDatabase()
    console.log('[Photo] Repaired metadata for', repaired, 'photos')
  }
}

export function registerPhotoHandlers(): void {
  ipcMain.handle('photos:listByEvent', async (_event, eventId: string, sortBy?: string) => {
    const db = getDb()
    const orderCol = sortBy === 'file_name' ? 'file_name' : 'created_at'
    const rows = queryAll(db, `SELECT * FROM photos WHERE event_id = ? AND deleted_at IS NULL ORDER BY ${orderCol} ASC`, [eventId])
    // Auto-repair 0×0 dimensions and missing metadata for existing photos
    await repairZeroDimensions(db, rows)
    await repairMetadata(db, rows)

    // Attach version summary to each photo
    const photos = rows.map(deserializePhoto)
    attachVersionSummary(db, photos)

    console.log('[IPC] photos:listByEvent →', rows.length, 'photos for', eventId, 'sortBy:', sortBy || 'created_at')
    return photos
  })

  ipcMain.handle('photos:get', async (_event, photoId: string) => {
    const db = getDb()
    const row = queryOne(db, 'SELECT * FROM photos WHERE id = ?', [photoId])
    if (!row) return null
    return deserializePhoto(row)
  })

  ipcMain.handle('photos:updateRating', async (_event, photoId: string, rating: number) => {
    const db = getDb()
    const now = new Date().toISOString()
    db.run('UPDATE photos SET rating = ?, updated_at = ? WHERE id = ?', [rating, now, photoId])
    persistDatabase()
    const ev = db.exec('SELECT event_id FROM photos WHERE id = ?', [photoId])
    if (ev.length > 0 && ev[0].values.length > 0) syncEventJsonPhotos(ev[0].values[0][0] as string)
    return { success: true }
  })

  ipcMain.handle('photos:updateFlag', async (_event, photoId: string, flag: string | null) => {
    const db = getDb()
    const now = new Date().toISOString()
    db.run('UPDATE photos SET flag = ?, updated_at = ? WHERE id = ?', [flag, now, photoId])
    persistDatabase()
    const ev = db.exec('SELECT event_id FROM photos WHERE id = ?', [photoId])
    if (ev.length > 0 && ev[0].values.length > 0) syncEventJsonPhotos(ev[0].values[0][0] as string)
    return { success: true }
  })

  ipcMain.handle('photos:updateColorLabel', async (_event, photoId: string, colorLabel: string | null) => {
    const db = getDb()
    const now = new Date().toISOString()
    db.run('UPDATE photos SET color_label = ?, updated_at = ? WHERE id = ?', [colorLabel, now, photoId])
    persistDatabase()
    const ev = db.exec('SELECT event_id FROM photos WHERE id = ?', [photoId])
    if (ev.length > 0 && ev[0].values.length > 0) syncEventJsonPhotos(ev[0].values[0][0] as string)
    return { success: true }
  })

  ipcMain.handle('photos:setNeedsEdit', async (_event, photoId: string, needsEdit: boolean) => {
    const db = getDb()
    const now = new Date().toISOString()
    db.run('UPDATE photos SET needs_edit = ?, updated_at = ? WHERE id = ?', [needsEdit ? 1 : 0, now, photoId])
    persistDatabase()
    const ev = db.exec('SELECT event_id FROM photos WHERE id = ?', [photoId])
    if (ev.length > 0 && ev[0].values.length > 0) syncEventJsonPhotos(ev[0].values[0][0] as string)
    return { success: true }
  })

  ipcMain.handle('photos:setEdited', async (_event, photoId: string, isEdited: boolean) => {
    const db = getDb()
    const now = new Date().toISOString()
    db.run('UPDATE photos SET is_edited = ?, updated_at = ? WHERE id = ?', [isEdited ? 1 : 0, now, photoId])
    persistDatabase()
    const ev = db.exec('SELECT event_id FROM photos WHERE id = ?', [photoId])
    if (ev.length > 0 && ev[0].values.length > 0) syncEventJsonPhotos(ev[0].values[0][0] as string)
    return { success: true }
  })

  ipcMain.handle('photos:delete', async (_event, photoIds: string[]): Promise<{ success: boolean; deleted: number; error?: string }> => {
    const db = getDb()
    const now = new Date().toISOString()
    let deleted = 0
    const syncedEvents = new Set<string>()

    try {
      for (const photoId of photoIds) {
        const rows = db.exec('SELECT id, event_id FROM photos WHERE id = ? AND deleted_at IS NULL', [photoId])
        if (rows.length === 0 || rows[0].values.length === 0) continue

        const eventId = rows[0].values[0][1] as string
        db.run('UPDATE photos SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, photoId])
        deleted++
        if (eventId) syncedEvents.add(eventId)
      }

      persistDatabase()
      syncedEvents.forEach(syncEventJsonPhotos)
      return { success: true, deleted }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Photo] Soft delete failed:', msg)
      return { success: false, deleted, error: msg }
    }
  })

  ipcMain.handle('photos:listTrash', async (): Promise<Photo[]> => {
    const db = getDb()
    const rows = queryAll(db, `
      SELECT p.*, e.name as event_name
      FROM photos p
      LEFT JOIN events e ON e.id = p.event_id
      WHERE p.deleted_at IS NOT NULL
      ORDER BY p.deleted_at DESC
    `)
    console.log('[IPC] photos:listTrash →', rows.length, 'trashed photos')
    return rows.map(deserializePhoto)
  })

  ipcMain.handle('photos:restore', async (_event, photoIds: string[]): Promise<{ success: boolean; restored: number; error?: string }> => {
    const db = getDb()
    const now = new Date().toISOString()
    let restored = 0
    const syncedEvents = new Set<string>()

    try {
      for (const photoId of photoIds) {
        const ev = db.exec('SELECT event_id FROM photos WHERE id = ?', [photoId])
        db.run('UPDATE photos SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL', [now, photoId])
        restored++
        if (ev.length > 0 && ev[0].values.length > 0) syncedEvents.add(ev[0].values[0][0] as string)
      }
      persistDatabase()
      syncedEvents.forEach(syncEventJsonPhotos)
      return { success: true, restored }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Photo] Restore failed:', msg)
      return { success: false, restored, error: msg }
    }
  })

  ipcMain.handle('photos:emptyTrash', async (): Promise<{ success: boolean; deleted: number; error?: string }> => {
    const db = getDb()
    let deleted = 0
    const syncedEvents = new Set<string>()

    try {
      const rows = queryAll(db, 'SELECT id, file_path, thumbnail_path, event_id FROM photos WHERE deleted_at IS NOT NULL')

      for (const row of rows) {
        if (row.file_path && fs.existsSync(row.file_path as string)) {
          try { fs.unlinkSync(row.file_path as string) } catch {}
        }
        if (row.thumbnail_path && fs.existsSync(row.thumbnail_path as string)) {
          try { fs.unlinkSync(row.thumbnail_path as string) } catch {}
        }
        if (row.event_id) syncedEvents.add(row.event_id as string)
        db.run('DELETE FROM photos WHERE id = ?', [row.id])
        deleted++
      }

      // Also permanently delete soft-deleted events that have no remaining photos
      db.run(`
        DELETE FROM events WHERE deleted_at IS NOT NULL
        AND id NOT IN (SELECT DISTINCT event_id FROM photos)
      `)

      persistDatabase()
      syncedEvents.forEach(syncEventJsonPhotos)
      return { success: true, deleted }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Photo] Empty trash failed:', msg)
      return { success: false, deleted, error: msg }
    }
  })

  ipcMain.handle('photos:refreshMetadata', async (_event, photoId: string, versionId?: string): Promise<{ success: boolean; metadata: Photo['metadata'] | null; debug?: string }> => {
    const db = getDb()

    // Resolve file path: if versionId provided, refresh version metadata; otherwise refresh photo metadata
    let filePath: string | null = null
    let targetTable = 'photos'
    let targetId = photoId

    if (versionId) {
      const vRow = queryOne(db, 'SELECT file_path, photo_id FROM photo_versions WHERE id = ?', [versionId])
      if (vRow?.file_path) {
        filePath = vRow.file_path as string
        targetTable = 'photo_versions'
        targetId = versionId
      }
    }

    if (!filePath) {
      const row = queryOne(db, 'SELECT file_path FROM photos WHERE id = ?', [photoId])
      filePath = (row?.file_path as string) || null
    }

    if (!filePath) return { success: false, metadata: null, debug: 'no file_path' }
    if (!fs.existsSync(filePath)) return { success: false, metadata: null, debug: 'file not found: ' + filePath }

    try {
      const newMeta = await parseMetadata(filePath)
      if (newMeta && Object.keys(newMeta).length > 0) {
        const now = new Date().toISOString()
        const metaJson = JSON.stringify(newMeta)
        if (targetTable === 'photo_versions') {
          db.run('UPDATE photo_versions SET metadata = ? WHERE id = ?', [metaJson, targetId])
          db.run('UPDATE photo_versions SET width = ?, height = ? WHERE id = ?', [newMeta.imageWidth || 0, newMeta.imageHeight || 0, targetId])
        } else {
          db.run('UPDATE photos SET metadata = ?, updated_at = ? WHERE id = ?', [metaJson, now, targetId])
          if (newMeta.imageWidth) db.run('UPDATE photos SET width = ? WHERE id = ?', [newMeta.imageWidth, targetId])
          if (newMeta.imageHeight) db.run('UPDATE photos SET height = ? WHERE id = ?', [newMeta.imageHeight, targetId])
        }
        persistDatabase()
        return { success: true, metadata: newMeta }
      }
      return { success: false, metadata: null, debug: 'parseMetadata returned null/empty' }
    } catch (err) {
      console.error('[Photo] Refresh metadata failed:', err)
      return { success: false, metadata: null, debug: String(err) }
    }
  })

  // Debug: test what parseMetadata returns for a given file
  ipcMain.handle('photos:testMetadata', async (_event, photoId: string): Promise<any> => {
    const db = getDb()
    const row = queryOne(db, 'SELECT id, file_path FROM photos WHERE id = ?', [photoId])
    if (!row || !row.file_path) return { error: 'no file_path', filePath: null }
    const filePath = row.file_path as string
    try {
      const exifr = await import('exifr')
      const raw = await exifr.default.parse(filePath, { translateKeys: true })
      const meta = await parseMetadata(filePath)
      return {
        filePath,
        exists: require('fs').existsSync(filePath),
        rawKeys: raw ? Object.keys(raw) : null,
        rawSample: raw,
        parsedMeta: meta,
      }
    } catch (err) {
      return { error: String(err), filePath, exists: require('fs').existsSync(filePath) }
    }
  })

  // ── Photo Version CRUD ────────────────────────────────────────────────

  ipcMain.handle('photos:listVersions', async (_event, photoId: string): Promise<PhotoVersion[]> => {
    const db = getDb()
    const rows = queryAll(db,
      'SELECT * FROM photo_versions WHERE photo_id = ? ORDER BY is_original DESC, created_at ASC',
      [photoId],
    )
    return rows.map(deserializePhotoVersion)
  })

  ipcMain.handle('photos:getVersion', async (_event, versionId: string): Promise<PhotoVersion | null> => {
    const db = getDb()
    const row = queryOne(db, 'SELECT * FROM photo_versions WHERE id = ?', [versionId])
    if (!row) return null
    return deserializePhotoVersion(row)
  })

  ipcMain.handle('photos:deleteVersion', async (_event, versionId: string): Promise<{ success: boolean; error?: string }> => {
    const db = getDb()
    try {
      const row = queryOne(db, 'SELECT * FROM photo_versions WHERE id = ?', [versionId])
      if (!row) return { success: false, error: 'Version not found' }
      if ((row.is_original as number) === 1) return { success: false, error: 'Cannot delete original version' }

      // Delete the file on disk
      const filePath = row.file_path as string
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath) } catch {}
      }
      // Delete thumbnail
      const thumbPath = row.thumbnail_path as string
      if (thumbPath && fs.existsSync(thumbPath)) {
        try { fs.unlinkSync(thumbPath) } catch {}
      }

      db.run('DELETE FROM photo_versions WHERE id = ?', [versionId])
      persistDatabase()

      // Sync event.json
      const photoRow = queryOne(db, 'SELECT event_id FROM photos WHERE id = ?', [row.photo_id])
      if (photoRow) syncEventJsonPhotos(photoRow.event_id as string)

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Photo] Failed to delete version:', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('photos:setDefaultVersion', async (_event, data: { photoId: string; versionId: string }): Promise<{ success: boolean; error?: string }> => {
    const db = getDb()
    try {
      const ver = queryOne(db, 'SELECT id FROM photo_versions WHERE id = ? AND photo_id = ?', [data.versionId, data.photoId])
      if (!ver) return { success: false, error: 'Version not found for this photo' }

      db.run('UPDATE photos SET default_version_id = ?, updated_at = ? WHERE id = ?',
        [data.versionId, new Date().toISOString(), data.photoId])
      persistDatabase()

      const photoRow = queryOne(db, 'SELECT event_id FROM photos WHERE id = ?', [data.photoId])
      if (photoRow) syncEventJsonPhotos(photoRow.event_id as string)

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('photos:addVersion', async (_event, data: {
    photoId: string
    versionName: string
    filePath: string
    fileName: string
    fileSize: number
    width: number
    height: number
    metadata: string | null
    uploadedBy?: string | null
  }): Promise<{ success: boolean; version?: PhotoVersion; error?: string }> => {
    const db = getDb()
    const now = new Date().toISOString()
    try {
      // Copy file to event directory
      const photoRow = queryOne(db, 'SELECT event_id, file_name FROM photos WHERE id = ?', [data.photoId])
      if (!photoRow) return { success: false, error: 'Photo not found' }

      const folderName = getEventFolderName(photoRow.event_id as string)
      const eventDir = getEventDir(folderName)

      // Resolve filename and version name conflicts (unified with import.handler.ts)
      let finalFileName = data.fileName
      let finalVersionName = data.versionName
      const baseName = path.parse(data.fileName).name
      const ext = path.extname(data.fileName)
      const user = data.uploadedBy || 'user'

      // --- Resolve version name: query across ALL photos in the event ---
      const eventVersionNames = queryAll(db,
        `SELECT DISTINCT v.version_name FROM photo_versions v
         JOIN photos p ON v.photo_id = p.id
         WHERE p.event_id = ? AND v.uploaded_by = ?`,
        [photoRow.event_id, user],
      ).map(r => r.version_name as string)

      const prefix = user + ' · '
      const pattern = new RegExp('^' + user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' · (\\d+)$')
      let maxNum = 0
      for (const vn of eventVersionNames) {
        if (vn === user) maxNum = Math.max(maxNum, 1)
        const match = vn.match(pattern)
        if (match) maxNum = Math.max(maxNum, parseInt(match[1]!, 10))
      }
      finalVersionName = maxNum === 0 ? user + ' · 1' : user + ' · ' + (maxNum + 1)

      // --- Resolve filename: use versionKey for dedup ---
      const versionKey = finalVersionName.replace(/ · /g, '_')
      finalFileName = baseName + '_' + versionKey + ext

      // Find all existing version filenames for this photo
      const existingFNs = queryAll(db,
        'SELECT file_name FROM photo_versions WHERE photo_id = ?',
        [data.photoId],
      ).map(r => r.file_name as string)

      if (existingFNs.includes(finalFileName)) {
        let i = 1
        const nameNoExt = baseName + '_' + versionKey
        while (existingFNs.includes(finalFileName)) {
          finalFileName = nameNoExt + '_' + i + ext
          i++
        }
      }

      // Also ensure destination path doesn't exist on disk
      let destPath = path.join(eventDir, finalFileName)
      let diskCounter = 1
      while (fs.existsSync(destPath)) {
        finalFileName = baseName + '_' + versionKey + '_' + diskCounter + ext
        destPath = path.join(eventDir, finalFileName)
        diskCounter++
      }

      // Copy or move the file
      if (data.filePath !== destPath) {
        if (fs.existsSync(data.filePath)) {
          fs.copyFileSync(data.filePath, destPath)
        } else {
          return { success: false, error: 'Source file not found' }
        }
      }

      // Auto-detect dimensions if not provided
      let finalWidth = data.width
      let finalHeight = data.height
      if (!finalWidth || !finalHeight) {
        try {
          const meta = await sharp(destPath).metadata()
          if (meta.width) finalWidth = meta.width
          if (meta.height) finalHeight = meta.height
        } catch {}
      }

      const versionId = uuid()
      db.run(
        `INSERT INTO photo_versions (id, photo_id, version_name, file_path, file_name, file_size, width, height, metadata, is_original, uploaded_by, uploaded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [versionId, data.photoId, finalVersionName, destPath, finalFileName, data.fileSize,
         finalWidth, finalHeight, data.metadata, data.uploadedBy || null, now, now],
      )

      // Generate thumbnail
      try {
        const { generateThumbnail } = require('../services/thumbnail.service') as { generateThumbnail: Function }
        const thumbPath = await generateThumbnail(destPath, versionId, photoRow.event_id as string, folderName)
        if (thumbPath) {
          db.run('UPDATE photo_versions SET thumbnail_path = ? WHERE id = ?', [thumbPath, versionId])
        }
      } catch {}

      // Restore camera metadata from original version if new file lacks it
      const restoredMeta = await restoreCameraMetadata(db, data.photoId, destPath, data.metadata)
      if (restoredMeta) {
        db.run('UPDATE photo_versions SET metadata = ? WHERE id = ?', [restoredMeta, versionId])
      }

      persistDatabase()
      syncEventJsonPhotos(photoRow.event_id as string)

      const newVersion = queryOne(db, 'SELECT * FROM photo_versions WHERE id = ?', [versionId])
      return { success: true, version: newVersion ? deserializePhotoVersion(newVersion) : undefined }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  })

  // ── On-demand version migration: create versions for photos lacking them ──
  ipcMain.handle('photos:migrateVersions', async (_event, eventId?: string): Promise<{ migrated: number }> => {
    const db = getDb()
    try {
      const { v4: uuidV4 } = await import('uuid')
      const whereClause = eventId
        ? 'AND p.event_id = ?'
        : ''
      const params: unknown[] = []
      if (eventId) params.push(eventId)

      const orphanRows = db.exec(`
        SELECT p.id, p.file_path, p.file_name, p.file_size, p.width, p.height, p.metadata, p.created_at
        FROM photos p
        WHERE p.deleted_at IS NULL ${whereClause}
          AND NOT EXISTS (SELECT 1 FROM photo_versions v WHERE v.photo_id = p.id)
      `, params)
      if (orphanRows.length === 0 || orphanRows[0].values.length === 0) {
        return { migrated: 0 }
      }
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
        const { persistDatabase } = await import('../db/connection')
        persistDatabase()
        console.log('[IPC] Migrated', created, 'photos to photo_versions')
      }
      return { migrated: created }
    } catch (err) {
      console.error('[IPC] Version migration failed:', err)
      return { migrated: 0 }
    }
  })
}

function deserializePhotoVersion(row: Record<string, unknown>): PhotoVersion {
  return {
    id: row.id as string,
    photoId: row.photo_id as string,
    versionName: row.version_name as string,
    filePath: row.file_path as string,
    fileName: row.file_name as string,
    fileSize: row.file_size as number,
    width: row.width as number,
    height: row.height as number,
    thumbnailPath: (row.thumbnail_path as string) || null,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    isOriginal: (row.is_original as number) === 1,
    uploadedBy: (row.uploaded_by as string) || null,
    uploadedAt: (row.uploaded_at as string) || null,
    createdAt: row.created_at as string,
  }
}

/** Copy camera metadata (dateTimeOriginal, cameraMake, Model, Lens, aperture, shutter, ISO, focal)
 *  from the best available source version when the new version has none or is a JPEG upload.
 *  Returns the merged metadata JSON string (or null if none). */
export async function restoreCameraMetadata(
  db: ReturnType<typeof getDb>,
  photoId: string,
  destPath: string,
  currentMetadata: string | null,
): Promise<string | null> {
  // If the new file already has camera metadata, keep it
  if (currentMetadata) {
    try {
      const parsed = JSON.parse(currentMetadata)
      if (parsed.cameraModel || parsed.iso) return currentMetadata
    } catch {}
  }
  // Try to parse metadata from the new file itself
  try {
    const { parseMetadata } = require('../services/metadata.service')
    const freshMeta = await parseMetadata(destPath)
    if (freshMeta && (freshMeta.cameraModel || freshMeta.iso)) {
      return JSON.stringify(freshMeta)
    }
  } catch {}

  // Find the best source version (prefer original with camera metadata)
  const sourceRows = db.exec(`
    SELECT v.metadata, v.file_path FROM photo_versions v
    WHERE v.photo_id = ? AND v.id != ''
    ORDER BY v.is_original DESC, v.created_at ASC
  `, [photoId])
  if (sourceRows.length === 0 || sourceRows[0].values.length === 0) return null

  // Try each source version in priority order
  for (const row of sourceRows[0].values) {
    const sourceMetaStr = row[0] as string | null
    const sourceFilePath = row[1] as string
    if (sourceMetaStr) {
      try {
        const src = JSON.parse(sourceMetaStr)
        if (src.cameraModel || src.iso) {
          // Merge: keep new file's own width/height/fileType, copy camera metadata
          const merged: Record<string, unknown> = {}
          if (src.dateTimeOriginal) merged.dateTimeOriginal = src.dateTimeOriginal
          if (src.cameraMake) merged.cameraMake = src.cameraMake
          if (src.cameraModel) merged.cameraModel = src.cameraModel
          if (src.lensModel) merged.lensModel = src.lensModel
          if (src.focalLength) merged.focalLength = src.focalLength
          if (src.aperture) merged.aperture = src.aperture
          if (src.shutterSpeed) merged.shutterSpeed = src.shutterSpeed
          if (src.iso) merged.iso = src.iso
          if (src.gpsLatitude) merged.gpsLatitude = src.gpsLatitude
          if (src.gpsLongitude) merged.gpsLongitude = src.gpsLongitude
          if (Object.keys(merged).length > 0) return JSON.stringify(merged)
        }
      } catch {}
    }
    // Fallback: try parsing metadata from the source file directly
    if (sourceFilePath) {
      try {
        const { parseMetadata } = require('../services/metadata.service')
        const srcMeta = await parseMetadata(sourceFilePath)
        if (srcMeta && (srcMeta.cameraModel || srcMeta.iso)) {
          const merged: Record<string, unknown> = {}
          if (srcMeta.dateTimeOriginal) merged.dateTimeOriginal = srcMeta.dateTimeOriginal
          if (srcMeta.cameraMake) merged.cameraMake = srcMeta.cameraMake
          if (srcMeta.cameraModel) merged.cameraModel = srcMeta.cameraModel
          if (srcMeta.lensModel) merged.lensModel = srcMeta.lensModel
          if (srcMeta.focalLength) merged.focalLength = srcMeta.focalLength
          if (srcMeta.aperture) merged.aperture = srcMeta.aperture
          if (srcMeta.shutterSpeed) merged.shutterSpeed = srcMeta.shutterSpeed
          if (srcMeta.iso) merged.iso = srcMeta.iso
          if (srcMeta.gpsLatitude) merged.gpsLatitude = srcMeta.gpsLatitude
          if (srcMeta.gpsLongitude) merged.gpsLongitude = srcMeta.gpsLongitude
          if (Object.keys(merged).length > 0) return JSON.stringify(merged)
        }
      } catch {}
    }
  }
  return null
}

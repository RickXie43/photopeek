import { ipcMain } from 'electron'
import { getDb, persistDatabase } from '../db/connection'
import type { Photo } from '../../renderer/src/types/photo'
import { syncEventJsonPhotos } from './event.handler'
import { parseMetadata } from '../services/metadata.service'
import * as fs from 'fs'
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
  ipcMain.handle('photos:listByEvent', async (_event, eventId: string) => {
    const db = getDb()
    const rows = queryAll(db, 'SELECT * FROM photos WHERE event_id = ? AND deleted_at IS NULL ORDER BY created_at ASC', [eventId])
    // Auto-repair 0×0 dimensions and missing metadata for existing photos
    await repairZeroDimensions(db, rows)
    await repairMetadata(db, rows)
    console.log('[IPC] photos:listByEvent →', rows.length, 'photos for', eventId)
    return rows.map(deserializePhoto)
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

  ipcMain.handle('photos:refreshMetadata', async (_event, photoId: string): Promise<{ success: boolean; metadata: Photo['metadata'] | null; debug?: string }> => {
    const db = getDb()
    const row = queryOne(db, 'SELECT id, file_path FROM photos WHERE id = ?', [photoId])
    if (!row || !row.file_path) {
      console.log('[Photo] refreshMetadata: no row or file_path')
      return { success: false, metadata: null, debug: 'no row or file_path' }
    }
    const filePath = row.file_path as string
    console.log('[Photo] refreshMetadata: filePath =', filePath)
    console.log('[Photo] refreshMetadata: exists =', fs.existsSync(filePath))
    if (!fs.existsSync(filePath)) {
      return { success: false, metadata: null, debug: 'file not found: ' + filePath }
    }
    try {
      const newMeta = await parseMetadata(filePath)
      console.log('[Photo] refreshMetadata: parseMetadata returned', JSON.stringify(newMeta))
      if (newMeta && Object.keys(newMeta).length > 0) {
        const now = new Date().toISOString()
        const metaJson = JSON.stringify(newMeta)
        db.run('UPDATE photos SET metadata = ?, updated_at = ? WHERE id = ?', [metaJson, now, photoId])
        if (newMeta.imageWidth) db.run('UPDATE photos SET width = ? WHERE id = ?', [newMeta.imageWidth, photoId])
        if (newMeta.imageHeight) db.run('UPDATE photos SET height = ? WHERE id = ?', [newMeta.imageHeight, photoId])
        persistDatabase()
        console.log('[Photo] refreshMetadata: success with', Object.keys(newMeta).length, 'fields')
        return { success: true, metadata: newMeta }
      }
      console.log('[Photo] refreshMetadata: parseMetadata returned null/empty')
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
}

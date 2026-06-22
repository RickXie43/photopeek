import { ipcMain } from 'electron'
import { getDb, persistDatabase } from '../db/connection'
import { v4 as uuid } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import type { PhotoEvent } from '../../renderer/src/types/photo'
import { getEventDir, getEventThumbnailsDir, generateFolderName, ensureUniqueFolderName } from '../services/library.service'

function allEvents(db: ReturnType<typeof getDb>): PhotoEvent[] {
  const rows = db.exec(`
    SELECT e.*, (SELECT COUNT(*) FROM photos WHERE event_id = e.id AND deleted_at IS NULL) as photo_count
    FROM events e WHERE e.deleted_at IS NULL ORDER BY e.created_at DESC
  `)
  if (rows.length === 0) return []

  const { columns, values } = rows[0]
  return values.map((row) => {
    const r = Object.fromEntries(columns.map((col, i) => [col, row[i]])) as Record<string, unknown>
    return {
      id: r.id as string,
      name: r.name as string,
      description: (r.description as string) || '',
      folderName: (r.folder_name as string) || r.id as string,
      coverPhotoId: (r.cover_photo_id as string) || null,
      photoCount: r.photo_count as number,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }
  })
}

/** Write/update event.json metadata file inside the event folder */
export function writeEventMetadata(eventId: string, folderName: string, data: {
  name: string
  description?: string
  createdAt: string
  updatedAt: string
}): void {
  const eventDir = getEventDir(folderName)
  fs.mkdirSync(eventDir, { recursive: true })
  const metaPath = path.join(eventDir, 'event.json')
  const metadata = {
    id: eventId,
    folderName,
    name: data.name,
    description: data.description || '',
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    createdYear: new Date(data.createdAt).getFullYear(),
    createdMonth: new Date(data.createdAt).getMonth() + 1,
  }
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8')
}

/**
 * Sync all photo key info + tag associations into event.json.
 * This enables lightweight sync: text metadata can be shared without photo files.
 */
export function syncEventJsonPhotos(eventId: string): void {
  const db = getDb()
  const folderName = getEventFolderName(eventId)
  const eventDir = getEventDir(folderName)
  const metaPath = path.join(eventDir, 'event.json')
  try {
    if (!fs.existsSync(metaPath)) return
    const raw = fs.readFileSync(metaPath, 'utf-8')
    const meta = JSON.parse(raw)

    // Sync tag definitions
    const tagRows = db.exec('SELECT id, name, color FROM tags WHERE event_id = ? ORDER BY name', [eventId])
    const tags: { id: string; name: string; color: string }[] = []
    if (tagRows.length > 0) {
      const { columns, values } = tagRows[0]
      for (const row of values) {
        tags.push({
          id: row[columns.indexOf('id')] as string,
          name: row[columns.indexOf('name')] as string,
          color: (row[columns.indexOf('color')] as string) || '#6366f1',
        })
      }
    }
    meta.tags = tags

    // Build photoId→[tagId] map
    const ptRows = db.exec('SELECT photo_id, tag_id FROM photo_tags')
    const photoTagMap: Record<string, string[]> = {}
    if (ptRows.length > 0) {
      const { columns, values } = ptRows[0]
      for (const row of values) {
        const pid = row[columns.indexOf('photo_id')] as string
        const tid = row[columns.indexOf('tag_id')] as string
        if (!photoTagMap[pid]) photoTagMap[pid] = []
        photoTagMap[pid].push(tid)
      }
    }

    // Sync photos key info
    const photoRows = db.exec(`
      SELECT id, file_name, file_size, width, height, rating, flag, color_label,
             is_edited, needs_edit, metadata, deleted_at, created_at
      FROM photos WHERE event_id = ? ORDER BY created_at
    `, [eventId])
    const photos: Record<string, any> = {}
    if (photoRows.length > 0) {
      const { columns, values } = photoRows[0]
      for (const row of values) {
        const id = row[columns.indexOf('id')] as string
        const mdStr = row[columns.indexOf('metadata')] as string | null
        let md: Record<string, any> = {}
        try { if (mdStr) md = JSON.parse(mdStr) } catch {}

        photos[id] = {
          fileName: row[columns.indexOf('file_name')] as string,
          fileSize: row[columns.indexOf('file_size')] as number,
          width: row[columns.indexOf('width')] as number,
          height: row[columns.indexOf('height')] as number,
          rating: row[columns.indexOf('rating')] as number,
          flag: row[columns.indexOf('flag')] as string || null,
          colorLabel: row[columns.indexOf('color_label')] as string || null,
          isEdited: (row[columns.indexOf('is_edited')] as number) === 1,
          needsEdit: (row[columns.indexOf('needs_edit')] as number) === 1,
          dateTimeOriginal: md.dateTimeOriginal || null,
          cameraModel: md.cameraModel || null,
          tags: photoTagMap[id] || [],
          deletedAt: (row[columns.indexOf('deleted_at')] as string) || null,
          createdAt: (row[columns.indexOf('created_at')] as string) || null,
        }
      }
    }
    meta.photos = photos

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
    console.log(`[Event] Synced ${Object.keys(photos).length} photos to event.json for ${folderName}`)
  } catch (err) {
    console.error('[Event] Failed to sync event.json photos:', err)
  }
}

export function getEventFolderName(eventId: string): string {
  const db = getDb()
  const rows = db.exec('SELECT folder_name FROM events WHERE id = ?', [eventId])
  if (rows.length === 0 || rows[0].values.length === 0) return eventId
  const folderName = rows[0].values[0][0] as string
  return folderName || eventId // fallback to eventId if folder_name is empty
}

export function registerEventHandlers(): void {
  ipcMain.handle('events:list', async () => {
    const db = getDb()
    const result = allEvents(db)
    console.log('[IPC] events:list →', result.length, 'events')
    return result
  })

  ipcMain.handle('events:create', async (_event, data: { name: string; description?: string }) => {
    const db = getDb()
    const id = uuid()
    const now = new Date().toISOString()

    // Generate human-readable folder name
    const rawFolderName = generateFolderName(data.name, now)
    const folderName = ensureUniqueFolderName(rawFolderName)

    // Create event folder and write metadata
    writeEventMetadata(id, folderName, {
      name: data.name,
      description: data.description,
      createdAt: now,
      updatedAt: now,
    })

    // Create thumbnails folder
    const thumbDir = getEventThumbnailsDir(folderName)
    fs.mkdirSync(thumbDir, { recursive: true })

    db.run(
      'INSERT INTO events (id, name, description, folder_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, data.name, data.description || '', folderName, now, now]
    )
    persistDatabase()
    return {
      id,
      name: data.name,
      description: data.description || '',
      folderName,
      photoCount: 0,
      coverPhotoId: null,
      createdAt: now,
      updatedAt: now,
    }
  })

  ipcMain.handle('events:update', async (_event, data: { id: string; name?: string; description?: string }) => {
    const db = getDb()
    const now = new Date().toISOString()
    const folderName = getEventFolderName(data.id)

    if (data.name !== undefined) {
      db.run('UPDATE events SET name = ?, updated_at = ? WHERE id = ?', [data.name, now, data.id])
    }
    if (data.description !== undefined) {
      db.run('UPDATE events SET description = ?, updated_at = ? WHERE id = ?', [data.description, now, data.id])
    }

    // Update event.json metadata
    const rows = db.exec('SELECT name, description, created_at FROM events WHERE id = ?', [data.id])
    if (rows.length > 0 && rows[0].values.length > 0) {
      const r = rows[0].values[0]
      writeEventMetadata(data.id, folderName, {
        name: (data.name ?? r[0]) as string,
        description: (data.description ?? r[1]) as string,
        createdAt: r[2] as string,
        updatedAt: now,
      })
    }

    persistDatabase()
    syncEventJsonPhotos(data.id)
    return { success: true }
  })

  ipcMain.handle('events:rename', async (_event, params: { id: string; newName: string }): Promise<{ success: boolean; folderName?: string; error?: string }> => {
    const db = getDb()
    const now = new Date().toISOString()

    try {
      // Get old folder name from DB
      const oldRows = db.exec('SELECT folder_name, name FROM events WHERE id = ?', [params.id])
      if (oldRows.length === 0 || oldRows[0].values.length === 0) {
        return { success: false, error: '事件不存在' }
      }

      const oldFolderName = (oldRows[0].values[0][0] || params.id) as string

      // Generate new folder name from the new event name, preserving original creation date
      const createdRows = db.exec('SELECT created_at FROM events WHERE id = ?', [params.id])
      const createdAt = (createdRows[0]?.values[0]?.[0] || now) as string
      const rawNewFolder = generateFolderName(params.newName, createdAt)
      const newFolderName = ensureUniqueFolderName(rawNewFolder)

      // Rename event folder on disk
      const oldEventDir = getEventDir(oldFolderName)
      const newEventDir = getEventDir(newFolderName)
      if (fs.existsSync(oldEventDir)) {
        fs.renameSync(oldEventDir, newEventDir)
      }

      // Rename thumbnails folder on disk
      const oldThumbDir = getEventThumbnailsDir(oldFolderName)
      const newThumbDir = getEventThumbnailsDir(newFolderName)
      if (fs.existsSync(oldThumbDir)) {
        fs.renameSync(oldThumbDir, newThumbDir)
      }

      // Update DB
      db.run('UPDATE events SET name = ?, folder_name = ?, updated_at = ? WHERE id = ?',
        [params.newName, newFolderName, now, params.id])

      // Update file paths in photos table (folder name changed)
      const oldPrefix = path.join('events', oldFolderName) + path.sep
      const newPrefix = path.join('events', newFolderName) + path.sep
      const photoRows = db.exec('SELECT id, file_path, thumbnail_path FROM photos WHERE event_id = ?', [params.id])
      if (photoRows.length > 0) {
        const { columns, values } = photoRows[0]
        for (const row of values) {
          const photoId = row[columns.indexOf('id')]
          const oldFilePath = row[columns.indexOf('file_path')] as string
          const oldThumbPath = row[columns.indexOf('thumbnail_path')] as string | null

          if (oldFilePath) {
            const newFilePath = oldFilePath.replace(oldPrefix, newPrefix)
            db.run('UPDATE photos SET file_path = ?, updated_at = ? WHERE id = ?', [newFilePath, now, photoId])
          }
          if (oldThumbPath) {
            const newThumbPath = oldThumbPath.replace(oldPrefix, newPrefix)
            db.run('UPDATE photos SET thumbnail_path = ?, updated_at = ? WHERE id = ?', [newThumbPath, now, photoId])
          }
        }
      }

      // Update event.json
      writeEventMetadata(params.id, newFolderName, {
        name: params.newName,
        description: '',
        createdAt,
        updatedAt: now,
      })

      persistDatabase()
      syncEventJsonPhotos(params.id)
      return { success: true, folderName: newFolderName }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Event] Rename failed:', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('events:delete', async (_event, id: string) => {
    const db = getDb()
    const now = new Date().toISOString()

    // Soft delete: set deleted_at on the event and all its photos
    db.run('UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
    db.run('UPDATE photos SET deleted_at = ?, updated_at = ? WHERE event_id = ? AND deleted_at IS NULL', [now, now, id])
    persistDatabase()
    syncEventJsonPhotos(id)
    return { success: true }
  })

  ipcMain.handle('events:restore', async (_event, id: string) => {
    const db = getDb()
    const now = new Date().toISOString()

    // Restore: clear deleted_at on the event and all its photos
    db.run('UPDATE events SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL', [now, id])
    db.run('UPDATE photos SET deleted_at = NULL, updated_at = ? WHERE event_id = ? AND deleted_at IS NOT NULL', [now, id])
    persistDatabase()
    syncEventJsonPhotos(id)
    return { success: true }
  })

  ipcMain.handle('events:listTrash', async (): Promise<PhotoEvent[]> => {
    const db = getDb()
    const rows = db.exec(`
      SELECT e.*, (SELECT COUNT(*) FROM photos WHERE event_id = e.id) as photo_count
      FROM events e WHERE e.deleted_at IS NOT NULL ORDER BY e.deleted_at DESC
    `)
    if (rows.length === 0) return []

    const { columns, values } = rows[0]
    return values.map((row) => {
      const r = Object.fromEntries(columns.map((col, i) => [col, row[i]])) as Record<string, unknown>
      return {
        id: r.id as string,
        name: r.name as string,
        description: (r.description as string) || '',
        folderName: (r.folder_name as string) || r.id as string,
        coverPhotoId: (r.cover_photo_id as string) || null,
        photoCount: r.photo_count as number,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
      }
    })
  })
}

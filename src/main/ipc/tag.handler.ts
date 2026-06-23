import { ipcMain } from 'electron'
import { getDb, persistDatabase } from '../db/connection'
import { syncEventJsonPhotos } from './event.handler'
import { v4 as uuid } from 'uuid'
import type { Tag, Photo } from '../../renderer/src/types/photo'

/** Generate a deterministic color from a tag name */
function tagColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue}, 55%, 50%)`
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

function allTagsForEvent(db: ReturnType<typeof getDb>, eventId: string): Tag[] {
  // Only return tags that are associated with at least one non-deleted photo
  const rows = db.exec(`
    SELECT DISTINCT t.* FROM tags t
    INNER JOIN photo_tags pt ON pt.tag_id = t.id
    INNER JOIN photos p ON p.id = pt.photo_id AND p.deleted_at IS NULL
    WHERE t.event_id = ? ORDER BY t.name ASC
  `, [eventId])
  if (rows.length === 0) return []
  const { columns, values } = rows[0]
  return values.map((row) => {
    const r = Object.fromEntries(columns.map((col, i) => [col, row[i]])) as Record<string, unknown>
    return {
      id: r.id as string,
      eventId: r.event_id as string,
      name: r.name as string,
      color: (r.color as string) || '#6366f1',
      createdAt: r.created_at as string,
    }
  })
}

function tagsForPhoto(db: ReturnType<typeof getDb>, photoId: string): Tag[] {
  const rows = db.exec(`
    SELECT t.* FROM tags t
    INNER JOIN photo_tags pt ON pt.tag_id = t.id
    WHERE pt.photo_id = ?
    ORDER BY t.name ASC
  `, [photoId])
  if (rows.length === 0) return []
  const { columns, values } = rows[0]
  return values.map((row) => {
    const r = Object.fromEntries(columns.map((col, i) => [col, row[i]])) as Record<string, unknown>
    return {
      id: r.id as string,
      eventId: r.event_id as string,
      name: r.name as string,
      color: (r.color as string) || '#6366f1',
      createdAt: r.created_at as string,
    }
  })
}

/** Sync all event data (tags + photos info) to event.json */
function syncEventJson(eventId: string): void {
  syncEventJsonPhotos(eventId)
}

export function registerTagHandlers(): void {
  ipcMain.handle('tags:list', async (_event, eventId: string): Promise<Tag[]> => {
    const db = getDb()
    return allTagsForEvent(db, eventId)
  })

  ipcMain.handle('tags:listForPhoto', async (_event, photoId: string): Promise<Tag[]> => {
    const db = getDb()
    return tagsForPhoto(db, photoId)
  })

  ipcMain.handle('tags:create', async (_event, data: { eventId: string; name: string; color?: string }): Promise<Tag | { error: string }> => {
    const db = getDb()
    const name = data.name.trim()
    if (!name) return { error: '标签名不能为空' }

    // Check for duplicate names in this event
    const existing = db.exec('SELECT id FROM tags WHERE event_id = ? AND name = ?', [data.eventId, name])
    if (existing.length > 0 && existing[0].values.length > 0) {
      return { error: '该事件中已存在同名标签' }
    }

    const id = uuid()
    const now = new Date().toISOString()
    const color = data.color || tagColor(name)

    db.run('INSERT INTO tags (id, event_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, data.eventId, name, color, now])
    persistDatabase()
    syncEventJson(data.eventId)

    return { id, eventId: data.eventId, name, color, createdAt: now }
  })

  ipcMain.handle('tags:delete', async (_event, data: { eventId: string; tagId: string }): Promise<{ success: boolean }> => {
    const db = getDb()
    db.run('DELETE FROM photo_tags WHERE tag_id = ?', [data.tagId])
    db.run('DELETE FROM tags WHERE id = ?', [data.tagId])
    persistDatabase()
    syncEventJson(data.eventId)
    return { success: true }
  })

  ipcMain.handle('tags:addToPhoto', async (_event, data: { photoId: string; tagId: string; eventId: string }): Promise<{ success: boolean }> => {
    const db = getDb()
    try {
      db.run('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)', [data.photoId, data.tagId])
      persistDatabase()
      syncEventJson(data.eventId)
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  ipcMain.handle('tags:removeFromPhoto', async (_event, data: { photoId: string; tagId: string; eventId: string }): Promise<{ success: boolean }> => {
    const db = getDb()
    db.run('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [data.photoId, data.tagId])
    persistDatabase()
    syncEventJson(data.eventId)
    return { success: true }
  })

  ipcMain.handle('tags:toggleOnPhoto', async (_event, data: { photoId: string; tagId: string; eventId: string }): Promise<{ hasTag: boolean }> => {
    const db = getDb()
    const existing = db.exec('SELECT 1 FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [data.photoId, data.tagId])
    const hasTag = existing.length > 0 && existing[0].values.length > 0

    if (hasTag) {
      db.run('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [data.photoId, data.tagId])
    } else {
      db.run('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)', [data.photoId, data.tagId])
    }
    persistDatabase()
    syncEventJson(data.eventId)
    return { hasTag: !hasTag }
  })

  ipcMain.handle('photos:listByTags', async (_event, data: { eventId: string; tagIds: string[]; sortBy?: string }): Promise<Photo[]> => {
    const db = getDb()
    let rows: Record<string, unknown>[] = []
    const orderCol = data.sortBy === 'file_name' ? 'file_name' : 'created_at'

    if (data.tagIds.length === 0) {
      const result = db.exec(`SELECT * FROM photos WHERE event_id = ? AND deleted_at IS NULL ORDER BY ${orderCol} ASC`, [data.eventId])
      if (result.length > 0) {
        const { columns, values } = result[0]
        rows = values.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])))
      }
    } else {
      // AND logic: photos that have ALL selected tags
      const placeholders = data.tagIds.map(() => '?').join(',')
      const sql = `
        SELECT p.* FROM photos p
        WHERE p.event_id = ? AND p.deleted_at IS NULL
          AND (SELECT COUNT(*) FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag_id IN (${placeholders})) = ?
        ORDER BY p.${orderCol} ASC
      `
      const result = db.exec(sql, [data.eventId, ...data.tagIds, data.tagIds.length])
      if (result.length > 0) {
        const { columns, values } = result[0]
        rows = values.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])))
      }
    }

    const photos = rows.map(deserializePhoto)
    // Attach version summary for GridView badges
    const { attachVersionSummary } = await import('./photo.handler')
    attachVersionSummary(db, photos)
    return photos
  })
}

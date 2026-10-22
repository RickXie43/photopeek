import { ipcMain } from 'electron'
import { getDb, persistDatabase, repairDatabaseTags } from '../db/connection'
import { syncEventJsonPhotos, ensureEventTagMetadata } from './event.handler'
import { getOrCreateTag, listEventTags, listPhotoTags, setPhotoTag, toggleNicknameTag } from '../services/tag.service'
import { withPersistedTags } from '../services/tag-persistence.service'
import type { Tag, Photo } from '../../renderer/src/types/photo'

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
    updatedAt: row.updated_at as string
  }
}

function allTagsForEvent(db: ReturnType<typeof getDb>, eventId: string): Tag[] {
  return listEventTags(db, eventId)
}

function tagsForPhoto(db: ReturnType<typeof getDb>, photoId: string): Tag[] {
  return listPhotoTags(db, photoId)
}

/** Sync all event data (tags + photos info) to event.json */
function syncEventJson(eventId: string): void {
  syncEventJsonPhotos(eventId)
}

export function registerTagHandlers(): void {
  ipcMain.handle('tags:list', async (_event, eventId: string): Promise<Tag[]> => {
    repairDatabaseTags(eventId)
    ensureEventTagMetadata(eventId)
    const db = getDb()
    return allTagsForEvent(db, eventId)
  })

  ipcMain.handle('tags:listForPhoto', async (_event, photoId: string): Promise<Tag[]> => {
    const db = getDb()
    const eventId = db.exec('SELECT event_id FROM photos WHERE id = ?', [photoId])[0]?.values[0]?.[0]
    if (typeof eventId === 'string') repairDatabaseTags(eventId)
    return tagsForPhoto(db, photoId)
  })

  ipcMain.handle(
    'tags:create',
    async (
      _event,
      data: { eventId: string; name: string; color?: string }
    ): Promise<Tag | { error: string }> => {
      const db = getDb()
      repairDatabaseTags(data.eventId)
      let tag: Tag
      try {
        tag = withPersistedTags(db, () => getOrCreateTag(db, data.eventId, data.name, data.color), persistDatabase)
      } catch (error) {
        return { error: error instanceof Error ? error.message : '创建标签失败' }
      }
      syncEventJson(data.eventId)
      return tag
    }
  )

  ipcMain.handle(
    'tags:delete',
    async (_event, data: { eventId: string; tagId: string }): Promise<{ success: boolean }> => {
      const db = getDb()
      const tag = db.exec('SELECT id FROM tags WHERE id = ? AND event_id = ?', [data.tagId, data.eventId])
      if (!tag.length || !tag[0].values.length) return { success: false }
      withPersistedTags(db, () => {
        db.run('DELETE FROM photo_tags WHERE tag_id = ?', [data.tagId])
        db.run('DELETE FROM tags WHERE id = ?', [data.tagId])
      }, persistDatabase)
      syncEventJson(data.eventId)
      return { success: true }
    }
  )

  ipcMain.handle(
    'tags:addToPhoto',
    async (
      _event,
      data: { photoId: string; tagId: string; eventId: string }
    ): Promise<{ success: boolean }> => {
      const db = getDb()
      repairDatabaseTags(data.eventId)
      withPersistedTags(db, () => setPhotoTag(db, data.photoId, data.eventId, data.tagId, true), persistDatabase)
      syncEventJson(data.eventId)
      return { success: true }
    }
  )

  ipcMain.handle(
    'tags:removeFromPhoto',
    async (
      _event,
      data: { photoId: string; tagId: string; eventId: string }
    ): Promise<{ success: boolean }> => {
      const db = getDb()
      repairDatabaseTags(data.eventId)
      withPersistedTags(db, () => setPhotoTag(db, data.photoId, data.eventId, data.tagId, false), persistDatabase)
      syncEventJson(data.eventId)
      return { success: true }
    }
  )

  ipcMain.handle(
    'tags:toggleOnPhoto',
    async (
      _event,
      data: { photoId: string; tagId: string; eventId: string }
    ): Promise<{ hasTag: boolean }> => {
      const db = getDb()
      repairDatabaseTags(data.eventId)
      const hasTag = withPersistedTags(db, () => setPhotoTag(db, data.photoId, data.eventId, data.tagId), persistDatabase)
      syncEventJson(data.eventId)
      return { hasTag }
    }
  )

  ipcMain.handle(
    'tags:toggleNicknameOnPhoto',
    async (_event, data: { photoId: string; eventId: string; nickname: string }) => {
      repairDatabaseTags(data.eventId)
      const db = getDb()
      const result = withPersistedTags(db, () => toggleNicknameTag(db, data), persistDatabase)
      const synced = syncEventJsonPhotos(data.eventId)
      return {
        ...result,
        warning: synced ? undefined : '标签已保存，事件信息暂未同步，下次打开事件会自动重试'
      }
    }
  )

  ipcMain.handle(
    'photos:listByTagsOr',
    async (
      _event,
      data: { eventId: string; tagIds: string[]; sortBy?: string }
    ): Promise<Photo[]> => {
      const db = getDb()
      const { repairMissingThumbnails } = await import('./photo.handler')
      await repairMissingThumbnails(db, data.eventId)
      let rows: Record<string, unknown>[] = []
      const orderCol = data.sortBy === 'file_name' ? 'file_name' : 'created_at'

      if (data.tagIds.length === 0) {
        const result = db.exec(
          `SELECT * FROM photos WHERE event_id = ? AND deleted_at IS NULL ORDER BY ${orderCol} ASC`,
          [data.eventId]
        )
        if (result.length > 0) {
          const { columns, values } = result[0]
          rows = values.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])))
        }
      } else {
        // OR logic: photos that have ANY of the selected tags
        const placeholders = data.tagIds.map(() => '?').join(',')
        const sql = `
        SELECT DISTINCT p.* FROM photos p
        INNER JOIN photo_tags pt ON pt.photo_id = p.id
        WHERE p.event_id = ? AND p.deleted_at IS NULL
          AND pt.tag_id IN (${placeholders})
        ORDER BY p.${orderCol} ASC
      `
        const result = db.exec(sql, [data.eventId, ...data.tagIds])
        if (result.length > 0) {
          const { columns, values } = result[0]
          rows = values.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])))
        }
      }

      const photos = rows.map(deserializePhoto)
      const { attachVersionSummary } = await import('./photo.handler')
      attachVersionSummary(db, photos)
      return photos
    }
  )

  ipcMain.handle(
    'photos:listByTags',
    async (
      _event,
      data: { eventId: string; tagIds: string[]; sortBy?: string }
    ): Promise<Photo[]> => {
      const db = getDb()
      const { repairMissingThumbnails } = await import('./photo.handler')
      await repairMissingThumbnails(db, data.eventId)
      let rows: Record<string, unknown>[] = []
      const orderCol = data.sortBy === 'file_name' ? 'file_name' : 'created_at'

      if (data.tagIds.length === 0) {
        const result = db.exec(
          `SELECT * FROM photos WHERE event_id = ? AND deleted_at IS NULL ORDER BY ${orderCol} ASC`,
          [data.eventId]
        )
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
    }
  )
}

import { randomUUID } from 'node:crypto'
import type { Database, SqlValue } from 'sql.js'
import type { Tag } from '../../renderer/src/types/photo'

function rows(db: Database, sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
  const result = db.exec(sql, params)[0]
  return result
    ? result.values.map((row) => Object.fromEntries(result.columns.map((col, i) => [col, row[i]])))
    : []
}

function toTag(row: Record<string, SqlValue>): Tag {
  return {
    id: String(row.id),
    eventId: row.event_id === null ? null : String(row.event_id),
    name: String(row.name),
    color: String(row.color || '#6366f1'),
    createdAt: String(row.created_at)
  }
}

function tagColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return `hsl(${((hash % 360) + 360) % 360}, 55%, 50%)`
}

export function listEventTags(db: Database, eventId: string, usedOnly = true): Tag[] {
  return rows(
    db,
    `SELECT t.* FROM tags t WHERE t.event_id = ? ${
      usedOnly
        ? `AND EXISTS (
      SELECT 1 FROM photo_tags pt JOIN photos p ON p.id = pt.photo_id
      WHERE pt.tag_id = t.id AND p.event_id = t.event_id AND p.deleted_at IS NULL
    )`
        : ''
    } ORDER BY t.name, t.id`,
    [eventId]
  ).map(toTag)
}

export function listPhotoTags(db: Database, photoId: string): Tag[] {
  return rows(
    db,
    `SELECT t.* FROM tags t
    JOIN photo_tags pt ON pt.tag_id = t.id JOIN photos p ON p.id = pt.photo_id
    WHERE p.id = ? AND t.event_id = p.event_id ORDER BY t.name, t.id`,
    [photoId]
  ).map(toTag)
}

export function getOrCreateTag(db: Database, eventId: string, name: string, color?: string): Tag {
  name = name.trim()
  if (!name) throw new Error('标签名不能为空')
  if (!rows(db, 'SELECT id FROM events WHERE id = ? AND deleted_at IS NULL', [eventId]).length) {
    throw new Error('事件不存在或已删除，请重新打开事件')
  }
  // Look up every definition, including tags whose last photo was untagged.
  const existing = rows(
    db,
    'SELECT * FROM tags WHERE event_id = ? AND name = ? ORDER BY created_at, id LIMIT 1',
    [eventId, name]
  )[0]
  if (existing) return toTag(existing)
  const tag: Tag = {
    id: randomUUID(),
    eventId,
    name,
    color: color || tagColor(name),
    createdAt: new Date().toISOString()
  }
  db.run('INSERT INTO tags (id, event_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)', [
    tag.id,
    eventId,
    name,
    tag.color,
    tag.createdAt
  ])
  return tag
}

function assertPhoto(db: Database, photoId: string, eventId: string): void {
  if (
    !rows(
      db,
      `SELECT p.id FROM photos p JOIN events e ON e.id = p.event_id
    WHERE p.id = ? AND p.event_id = ? AND p.deleted_at IS NULL AND e.deleted_at IS NULL`,
      [photoId, eventId]
    ).length
  ) {
    throw new Error('照片不存在或已删除，请重新打开事件')
  }
}

export function setPhotoTag(
  db: Database,
  photoId: string,
  eventId: string,
  tagId: string,
  enabled?: boolean
): boolean {
  assertPhoto(db, photoId, eventId)
  if (!rows(db, 'SELECT id FROM tags WHERE id = ? AND event_id = ?', [tagId, eventId]).length) {
    throw new Error('标签不存在或不属于当前事件，请刷新后重试')
  }
  const hasTag =
    rows(db, 'SELECT 1 FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [photoId, tagId])
      .length > 0
  const next = enabled ?? !hasTag
  if (next)
    db.run('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)', [photoId, tagId])
  else db.run('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [photoId, tagId])
  return next
}

/** One synchronous transaction: a stale renderer cache cannot create a duplicate tag. */
export function toggleNicknameTag(
  db: Database,
  data: { photoId: string; eventId: string; nickname: string }
): {
  tag: Tag
  hasTag: boolean
  photoTags: Tag[]
  eventTags: Tag[]
} {
  assertPhoto(db, data.photoId, data.eventId)
  db.run('SAVEPOINT nickname_tag_toggle')
  try {
    const tag = getOrCreateTag(db, data.eventId, data.nickname)
    const hasTag = setPhotoTag(db, data.photoId, data.eventId, tag.id)
    const result = {
      tag,
      hasTag,
      photoTags: listPhotoTags(db, data.photoId),
      eventTags: listEventTags(db, data.eventId)
    }
    db.run('RELEASE nickname_tag_toggle')
    return result
  } catch (error) {
    db.run('ROLLBACK TO nickname_tag_toggle; RELEASE nickname_tag_toggle')
    throw error
  }
}

export interface TagRepairResult {
  changed: boolean
  removedLinks: number
  movedLinks: number
  mergedTags: number
  renamedTags: number
  detachedTags: number
}

/** Repair relationships, preserving unused definitions, soft-deleted photos and valid labels. */
export function repairTagIntegrity(
  db: Database,
  eventId?: string,
  beforeRepair?: () => void
): TagRepairResult {
  const result: TagRepairResult = {
    changed: false,
    removedLinks: 0,
    movedLinks: 0,
    mergedTags: 0,
    renamedTags: 0,
    detachedTags: 0
  }
  const events = new Set(rows(db, 'SELECT id FROM events').map((row) => String(row.id)))
  let started = false
  const change = (sql: string, args: SqlValue[]): void => {
    if (!started) {
      beforeRepair?.()
      db.run('SAVEPOINT tag_integrity_repair')
      started = true
    }
    db.run(sql, args)
    result.changed = true
  }
  try {
    for (const link of rows(
      db,
      `SELECT pt.photo_id, pt.tag_id, p.id AS pid, t.id AS tid,
      p.event_id AS photo_event, t.event_id AS tag_event FROM photo_tags pt
      LEFT JOIN photos p ON p.id = pt.photo_id LEFT JOIN tags t ON t.id = pt.tag_id
      WHERE p.id IS NULL OR t.id IS NULL`
    )) {
      if (eventId && link.photo_event !== eventId && link.tag_event !== eventId) continue
      change('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [
        link.photo_id,
        link.tag_id
      ])
      result.removedLinks++
    }

    const canonical = new Map<string, string>()
    for (const tag of rows(db, 'SELECT * FROM tags ORDER BY created_at, id')) {
      if (eventId && tag.event_id !== eventId) continue
      if (tag.event_id !== null && !events.has(String(tag.event_id))) {
        // Same semantics as ON DELETE SET NULL; keep the user's definition.
        change('UPDATE tags SET event_id = NULL WHERE id = ?', [tag.id])
        result.detachedTags++
        continue
      }
      if (tag.event_id === null) continue
      const name = String(tag.name).trim()
      const key = JSON.stringify([tag.event_id, name])
      const keeper = canonical.get(key)
      if (keeper) {
        change(
          'INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) SELECT photo_id, ? FROM photo_tags WHERE tag_id = ?',
          [keeper, tag.id]
        )
        change('DELETE FROM photo_tags WHERE tag_id = ?', [tag.id])
        change('DELETE FROM tags WHERE id = ?', [tag.id])
        result.mergedTags++
      } else {
        canonical.set(key, String(tag.id))
        if (name !== tag.name) {
          change('UPDATE tags SET name = ? WHERE id = ?', [name, tag.id])
          result.renamedTags++
        }
      }
    }

    // A legacy/global or wrong-event tag is copied into the photo's event,
    // so fixing ownership does not discard the user's label on that photo.
    for (const link of rows(
      db,
      `SELECT pt.photo_id, pt.tag_id, p.event_id AS photo_event,
      t.event_id AS tag_event, t.name, t.color FROM photo_tags pt
      JOIN photos p ON p.id = pt.photo_id JOIN tags t ON t.id = pt.tag_id
      WHERE t.event_id IS NOT p.event_id`
    )) {
      if (eventId && link.photo_event !== eventId && link.tag_event !== eventId) continue
      const targetEvent = String(link.photo_event)
      if (!events.has(targetEvent)) continue
      const name = String(link.name).trim()
      let target = rows(
        db,
        'SELECT id FROM tags WHERE event_id = ? AND TRIM(name) = ? ORDER BY created_at, id LIMIT 1',
        [targetEvent, name]
      )[0]?.id
      if (!target) {
        target = randomUUID()
        change('INSERT INTO tags (id, event_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)', [
          target,
          targetEvent,
          name,
          link.color || tagColor(name),
          new Date().toISOString()
        ])
      }
      change('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)', [
        link.photo_id,
        target
      ])
      change('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [
        link.photo_id,
        link.tag_id
      ])
      result.movedLinks++
    }
    if (started) db.run('RELEASE tag_integrity_repair')
    return result
  } catch (error) {
    if (started) db.run('ROLLBACK TO tag_integrity_repair; RELEASE tag_integrity_repair')
    throw error
  }
}

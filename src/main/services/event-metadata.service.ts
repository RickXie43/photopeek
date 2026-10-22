import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface EventTagSnapshot {
  eventId: string
  tags: { id: string; name: string; color: string }[]
  photoTags: Record<string, string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Empty/unused tag definitions and soft-deleted photo IDs belong in this snapshot too. */
export function eventTagMetadataMatches(metadata: unknown, snapshot: EventTagSnapshot): boolean {
  if (
    !isRecord(metadata) ||
    metadata.id !== snapshot.eventId ||
    metadata.format !== 'photopeek-event' ||
    metadata.formatVersion !== 1 ||
    metadata.kind !== 'event' ||
    !Array.isArray(metadata.tags) ||
    !isRecord(metadata.photos)
  )
    return false

  if (metadata.tags.length !== snapshot.tags.length) return false
  const tags = new Map(snapshot.tags.map((tag) => [tag.id, tag]))
  const seenTags = new Set<string>()
  for (const tag of metadata.tags) {
    if (!isRecord(tag) || typeof tag.id !== 'string' || seenTags.has(tag.id)) return false
    const expected = tags.get(tag.id)
    if (!expected || tag.name !== expected.name || tag.color !== expected.color) return false
    seenTags.add(tag.id)
  }

  const ids = Object.keys(metadata.photos)
  if (ids.length !== Object.keys(snapshot.photoTags).length) return false
  for (const id of ids) {
    const photo = metadata.photos[id]
    const expected = snapshot.photoTags[id]
    if (
      !expected ||
      !isRecord(photo) ||
      !Array.isArray(photo.tags) ||
      photo.tags.length !== expected.length
    )
      return false
    const actualTags = new Set(photo.tags)
    if (actualTags.size !== expected.length || expected.some((tagId) => !actualTags.has(tagId)))
      return false
  }
  return true
}

/** Keep recoverable bytes before replacing malformed or wrong-event manifests. */
export function readEventMetadataFile(metaPath: string, eventId: string): Record<string, unknown> {
  if (!fs.existsSync(metaPath)) return {}
  const raw = fs.readFileSync(metaPath, 'utf8')
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || (value.id !== undefined && value.id !== eventId)) {
      throw new Error('Invalid event metadata object or event ID')
    }
    return value
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${metaPath}.corrupt-${stamp}-${randomUUID()}.bak`
    fs.copyFileSync(metaPath, backupPath, fs.constants.COPYFILE_EXCL)
    console.warn(`[Event] Preserved damaged event metadata: ${backupPath}`)
    return {}
  }
}

export function writeEventMetadataFile(metaPath: string, metadata: unknown): void {
  const tmpPath = `${metaPath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2), 'utf8')
    fs.renameSync(tmpPath, metaPath)
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
  }
}

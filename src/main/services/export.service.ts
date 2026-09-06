import { getDb } from '../db/connection'
import type {
  ExportOptions,
  ExportProgress,
  ExportResult,
  TagFilter,
} from '../../renderer/src/types/photo'
import * as fs from 'fs'
import * as path from 'path'

let cancelFlag = false

export function cancelExport(): void {
  cancelFlag = true
}

interface PhotoRow {
  id: string
  fileName: string
  rating: number
  flag: string | null
  metadata: string | null
}

interface VersionRow {
  id: string
  photoId: string
  versionName: string
  filePath: string
  fileName: string
  isOriginal: boolean
}

interface ExportItem {
  photo: PhotoRow
  version: VersionRow
  tags: string[]
}

/**
 * Resolve a path template by substituting {variable} placeholders.
 */
function resolveTemplate(template: string, vars: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value)
  }
  return result
}

/**
 * Build template variables from a photo, version, tags, and event name.
 */
function getTemplateVars(
  photo: PhotoRow,
  version: VersionRow,
  tags: string[],
  eventName: string
): Record<string, string> {
  const ext = path.extname(version.fileName)
  const originalName = path.basename(version.fileName, ext)
  const meta = photo.metadata
    ? (JSON.parse(photo.metadata) as Record<string, unknown>)
    : null
  const dateTimeOriginal = meta?.dateTimeOriginal as string | undefined
  const date = dateTimeOriginal ? new Date(dateTimeOriginal) : null

  let year = ''
  let month = ''
  let day = ''
  let dateStr = ''
  if (date && !isNaN(date.getTime())) {
    year = String(date.getFullYear())
    month = String(date.getMonth() + 1).padStart(2, '0')
    day = String(date.getDate()).padStart(2, '0')
    dateStr = `${year}-${month}-${day}`
  }

  return {
    originalName,
    extension: ext,
    version: version.versionName,
    tags: tags.join(','),
    firstTag: tags[0] || '',
    event: eventName,
    year,
    month,
    day,
    date: dateStr,
    rating: String(photo.rating),
    flag: photo.flag || 'none',
  }
}

/**
 * Check whether a photo passes the tag filter.
 * Returns true when there is no filter, or when the photo matches the rules.
 */
function passesTagFilter(
  photoTagIds: Set<string> | undefined,
  filter: TagFilter | null
): boolean {
  if (!filter) return true
  if (filter.includeTagIds.length === 0 && filter.excludeTagIds.length === 0) return true

  const photoTags = photoTagIds ?? new Set<string>()

  // Exclude: if any excluded tag is present → reject
  for (const excludeId of filter.excludeTagIds) {
    if (photoTags.has(excludeId)) return false
  }

  if (filter.includeTagIds.length === 0) return true // only exclude filter, everything left passes

  if (filter.mode === 'intersection') {
    // AND: photo must have ALL included tags
    return filter.includeTagIds.every((id) => photoTags.has(id))
  } else {
    // OR: photo must have at least one included tag
    return filter.includeTagIds.some((id) => photoTags.has(id))
  }
}

/**
 * Execute an export operation: query photos matching the filters,
 * resolve the output path template, and copy files with progress.
 */
export async function executeExport(
  options: ExportOptions,
  sendProgress: (progress: ExportProgress) => void
): Promise<ExportResult> {
  cancelFlag = false
  const db = getDb()
  const result: ExportResult = {
    success: true,
    exported: 0,
    skipped: 0,
    errors: [],
  }

  // ── 1. Get event info ──
  const eventRows = db.exec(
    'SELECT id, name, folder_name FROM events WHERE id = ? AND deleted_at IS NULL',
    [options.eventId]
  )
  if (eventRows.length === 0 || eventRows[0].values.length === 0) {
    return { ...result, success: false, errors: ['事件未找到'] }
  }
  const eCols = eventRows[0].columns
  const eventName = eventRows[0].values[0][eCols.indexOf('name')] as string

  // ── 2. Get photos ──
  const photoRows = db.exec(
    `SELECT id, file_name, rating, flag, metadata
     FROM photos
     WHERE event_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [options.eventId]
  )
  if (photoRows.length === 0 || photoRows[0].values.length === 0) {
    return { ...result, success: true, exported: 0, skipped: 0, errors: [] }
  }

  const pCols = photoRows[0].columns
  const photos: PhotoRow[] = photoRows[0].values.map((row) => ({
    id: row[pCols.indexOf('id')] as string,
    fileName: row[pCols.indexOf('file_name')] as string,
    rating: row[pCols.indexOf('rating')] as number,
    flag: row[pCols.indexOf('flag')] as string | null,
    metadata: row[pCols.indexOf('metadata')] as string | null,
  }))

  const photoIds = photos.map((p) => p.id)
  const idPlaceholders = photoIds.map(() => '?').join(',')

  // ── 3. Get versions ──
  const versionRows = db.exec(
    `SELECT id, photo_id, version_name, file_path, file_name, is_original
     FROM photo_versions
     WHERE photo_id IN (${idPlaceholders})`,
    photoIds
  )

  const photoVersions = new Map<string, VersionRow[]>()
  if (versionRows.length > 0) {
    const vCols = versionRows[0].columns
    for (const row of versionRows[0].values) {
      const photoId = row[vCols.indexOf('photo_id')] as string
      const ver: VersionRow = {
        id: row[vCols.indexOf('id')] as string,
        photoId,
        versionName: row[vCols.indexOf('version_name')] as string,
        filePath: row[vCols.indexOf('file_path')] as string,
        fileName: row[vCols.indexOf('file_name')] as string,
        isOriginal: (row[vCols.indexOf('is_original')] as number) === 1,
      }
      const existing = photoVersions.get(photoId) ?? []
      existing.push(ver)
      photoVersions.set(photoId, existing)
    }
  }

  // ── 4. Get photo-tag relationships ──
  const tagRows = db.exec(
    `SELECT photo_id, tag_id FROM photo_tags WHERE photo_id IN (${idPlaceholders})`,
    photoIds
  )

  const photoTagIds = new Map<string, Set<string>>()
  if (tagRows.length > 0) {
    const tCols = tagRows[0].columns
    for (const row of tagRows[0].values) {
      const photoId = row[tCols.indexOf('photo_id')] as string
      const tagId = row[tCols.indexOf('tag_id')] as string
      const existing = photoTagIds.get(photoId) ?? new Set<string>()
      existing.add(tagId)
      photoTagIds.set(photoId, existing)
    }
  }

  // ── 5. Get tag names ──
  const allTagIds = new Set<string>()
  for (const tagSet of photoTagIds.values()) {
    for (const id of tagSet) allTagIds.add(id)
  }

  const tagNames = new Map<string, string>()
  if (allTagIds.size > 0) {
    const tagIdArray = Array.from(allTagIds)
    const tagPlaceholders = tagIdArray.map(() => '?').join(',')
    const nameRows = db.exec(
      `SELECT id, name FROM tags WHERE id IN (${tagPlaceholders})`,
      tagIdArray
    )
    if (nameRows.length > 0) {
      const nCols = nameRows[0].columns
      for (const row of nameRows[0].values) {
        tagNames.set(row[nCols.indexOf('id')] as string, row[nCols.indexOf('name')] as string)
      }
    }
  }

  // ── 6. Build export items (apply version + tag filters) ──
  const exportItems: ExportItem[] = []

  for (const photo of photos) {
    // Tag filter
    if (!passesTagFilter(photoTagIds.get(photo.id), options.tagFilter)) continue

    // Tag names for template
    const photoTags = Array.from(photoTagIds.get(photo.id) ?? [])
      .map((tagId) => tagNames.get(tagId))
      .filter((n): n is string => !!n)

    const versions = photoVersions.get(photo.id) ?? []
    if (versions.length === 0) {
      result.errors.push(`${photo.fileName}: 没有版本`)
      continue
    }

    // Version filter
    let matchedVersions: VersionRow[]
    if (options.versionFilter.mode === 'original-only') {
      matchedVersions = versions.filter((v) => v.isOriginal)
      if (matchedVersions.length === 0) matchedVersions = [versions[0]] // fallback
    } else if (
      options.versionFilter.mode === 'selected-only' &&
      options.versionFilter.selectedVersionNames.length > 0
    ) {
      matchedVersions = versions.filter((v) =>
        options.versionFilter.selectedVersionNames.includes(v.versionName)
      )
    } else {
      matchedVersions = versions
    }

    for (const version of matchedVersions) {
      exportItems.push({ photo, version, tags: photoTags })
    }
  }

  if (exportItems.length === 0) {
    return {
      ...result,
      success: true,
      exported: 0,
      skipped: 0,
      errors: ['没有匹配筛选条件的照片'],
    }
  }

  // ── 7. Copy files ──
  const total = exportItems.length
  sendProgress({ current: 0, total, message: '准备导出...', percent: 0 })

  for (let i = 0; i < exportItems.length; i++) {
    if (cancelFlag) {
      return {
        ...result,
        success: false,
        exported: result.exported,
        skipped: 0,
        errors: [...result.errors, '导出已取消'],
      }
    }

    const item = exportItems[i]
    const vars = getTemplateVars(item.photo, item.version, item.tags, eventName)
    const relativePath = resolveTemplate(options.organizeTemplate, vars)
    const destPath = path.resolve(options.destinationFolder, relativePath)
    const destDir = path.dirname(destPath)

    // Create directory
    try {
      fs.mkdirSync(destDir, { recursive: true })
    } catch (err) {
      const msg = `${item.version.fileName}: 无法创建目录 ${destDir}`
      result.errors.push(msg)
      console.error('[Export]', msg, err)
      continue
    }

    // Check source
    if (!fs.existsSync(item.version.filePath)) {
      result.errors.push(`${item.version.fileName}: 源文件不存在`)
      continue
    }

    // Destination conflict
    if (fs.existsSync(destPath)) {
      if (options.overwriteMode === 'skip') {
        result.skipped++
        continue
      }
      // overwrite mode: proceed to copy (fs.cpSync with force: true)
    }

    // Copy
    try {
      fs.cpSync(item.version.filePath, destPath, { force: true })
      result.exported++
    } catch (err) {
      const msg = `${item.version.fileName}: 复制失败`
      result.errors.push(msg)
      console.error('[Export]', msg, err)
    }

    // Progress
    const percent = Math.round(((i + 1) / total) * 100)
    sendProgress({
      current: i + 1,
      total,
      message: `正在导出 (${i + 1}/${total}): ${item.version.fileName}`,
      percent,
    })
  }

  result.success = result.errors.length === 0 || result.exported > 0
  return result
}

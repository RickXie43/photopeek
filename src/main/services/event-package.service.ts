import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import { getDb, persistDatabase } from '../db/connection'
import {
  getEventDir,
  sanitizeFolderName,
  ensureUniqueFolderName,
  generateFolderName
} from './library.service'
import { writeEventMetadata, syncEventJsonPhotos } from '../ipc/event.handler'
import { generateThumbnail } from './thumbnail.service'

export interface EventPackageProgress {
  current: number
  total: number
  message: string
  percent: number
}

export interface EventPackageResult {
  success: boolean
  exported: number
  imported: number
  skipped: number
  errors: string[]
  eventId?: string
  eventName?: string
}

export interface EventPackagePreview {
  valid: boolean
  error?: string
  eventName: string
  folderName: string
  photoCount: number
  versionCount: number
  missingFiles: string[]
}

function rows(
  db: ReturnType<typeof getDb>,
  sql: string,
  params: unknown[] = []
): Record<string, unknown>[] {
  const result = db.exec(sql, params)
  if (!result.length) return []
  const { columns, values } = result[0]
  return values.map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i]])))
}

function safeRelativePath(root: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(root, relativePath)
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep
  return resolved === resolvedRoot || resolved.startsWith(prefix) ? resolved : null
}

function parseJson(value: unknown): unknown {
  if (!value || typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function safeFileName(fileName: string): string {
  const base = path.basename(fileName || 'unnamed')
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'unnamed'
}

function uniqueFilePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  let candidate = path.join(dir, fileName)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${index}${ext}`)
    index++
  }
  return candidate
}

function isRaw(fileName: string): boolean {
  return new Set([
    '.raw',
    '.cr2',
    '.cr3',
    '.nef',
    '.arw',
    '.rw2',
    '.orf',
    '.raf',
    '.srf',
    '.sr2'
  ]).has(path.extname(fileName).toLowerCase())
}

function versionFolder(version: {
  versionName: string
  fileName: string
  isOriginal: boolean
}): string {
  if (version.isOriginal && isRaw(version.fileName)) return 'raw'
  if (version.isOriginal) return '原图'
  return sanitizeFolderName(version.versionName) || '修图版本'
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temp = `${filePath}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temp, filePath)
}

/** Export one complete event as a portable folder with event.json manifest. */
export async function exportEventPackage(
  eventId: string,
  parentFolder: string,
  sendProgress: (progress: EventPackageProgress) => void
): Promise<EventPackageResult> {
  const db = getDb()
  const event = rows(db, 'SELECT * FROM events WHERE id = ? AND deleted_at IS NULL', [eventId])[0]
  if (!event)
    return { success: false, exported: 0, imported: 0, skipped: 0, errors: ['事件未找到'] }

  const folderName =
    sanitizeFolderName(
      (event.folder_name as string) ||
        generateFolderName(event.name as string, event.created_at as string)
    ) || eventId
  let packageDir = path.join(parentFolder, folderName)
  let suffix = 1
  while (fs.existsSync(packageDir)) {
    packageDir = path.join(parentFolder, `${folderName}_${suffix++}`)
  }
  fs.mkdirSync(packageDir, { recursive: true })

  const photos = rows(
    db,
    `SELECT * FROM photos WHERE event_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    [eventId]
  )
  const tags = rows(
    db,
    'SELECT id, name, color, created_at FROM tags WHERE event_id = ? ORDER BY name',
    [eventId]
  )
  const tagLinks = rows(
    db,
    `SELECT photo_id, tag_id FROM photo_tags WHERE photo_id IN (${photos.map(() => '?').join(',') || "''"})`,
    photos.map((photo) => photo.id)
  )
  const tagMap = new Map<string, string[]>()
  for (const link of tagLinks) {
    const values = tagMap.get(link.photo_id as string) || []
    values.push(link.tag_id as string)
    tagMap.set(link.photo_id as string, values)
  }

  const manifestPhotos: Record<string, any> = {}
  let totalVersions = 0
  for (const photo of photos) {
    const versions = rows(
      db,
      `SELECT * FROM photo_versions WHERE photo_id = ? ORDER BY is_original DESC, created_at ASC`,
      [photo.id]
    )
    totalVersions += versions.length
    manifestPhotos[photo.id as string] = {
      fileName: photo.file_name,
      fileSize: photo.file_size,
      width: photo.width,
      height: photo.height,
      rating: photo.rating,
      flag: photo.flag || null,
      colorLabel: photo.color_label || null,
      isEdited: photo.is_edited === 1,
      needsEdit: photo.needs_edit === 1,
      metadata: parseJson(photo.metadata),
      originalMetadata: parseJson(photo.original_metadata),
      createdAt: photo.created_at,
      updatedAt: photo.updated_at,
      tags: tagMap.get(photo.id as string) || [],
      versions: versions.map((version, index) => ({
        id: version.id,
        versionName: version.version_name,
        fileName: version.file_name,
        fileSize: version.file_size,
        width: version.width,
        height: version.height,
        metadata: parseJson(version.metadata),
        isOriginal: version.is_original === 1,
        uploadedBy: version.uploaded_by || null,
        uploadedAt: version.uploaded_at || null,
        createdAt: version.created_at,
        order: index,
        relativePath: `${versionFolder({ versionName: version.version_name as string, fileName: version.file_name as string, isOriginal: version.is_original === 1 })}/${safeFileName(version.file_name as string)}`
      }))
    }
  }

  const manifest = {
    format: 'photopeek-event',
    formatVersion: 1,
    kind: 'event',
    exportedAt: new Date().toISOString(),
    id: event.id,
    folderName,
    name: event.name,
    description: event.description || '',
    createdAt: event.created_at,
    updatedAt: event.updated_at,
    event: {
      id: event.id,
      folderName,
      name: event.name,
      description: event.description || '',
      createdAt: event.created_at,
      updatedAt: event.updated_at
    },
    tags,
    photos: manifestPhotos
  }

  let exported = 0
  const errors: string[] = []
  let current = 0
  sendProgress({ current: 0, total: totalVersions, message: '准备导出事件...', percent: 0 })
  for (const photo of Object.values(manifestPhotos) as any[]) {
    for (const version of photo.versions) {
      current++
      const source = rows(db, 'SELECT file_path FROM photo_versions WHERE id = ?', [version.id])[0]
        ?.file_path as string | undefined
      const destination = safeRelativePath(packageDir, version.relativePath)
      if (!destination) {
        errors.push(`${version.fileName}: 路径无效`)
      } else if (!source || !fs.existsSync(source)) {
        errors.push(`${version.fileName}: 源文件不存在`)
        version.available = false
      } else {
        try {
          fs.mkdirSync(path.dirname(destination), { recursive: true })
          const finalDestination = uniqueFilePath(
            path.dirname(destination),
            path.basename(destination)
          )
          if (finalDestination !== destination)
            version.relativePath = path.relative(packageDir, finalDestination).replace(/\\/g, '/')
          fs.copyFileSync(source, finalDestination)
          exported++
          version.available = true
        } catch (error) {
          errors.push(`${version.fileName}: ${(error as Error).message}`)
          version.available = false
        }
      }
      sendProgress({
        current,
        total: totalVersions,
        message: `正在导出: ${version.fileName}`,
        percent: Math.round((current / Math.max(totalVersions, 1)) * 100)
      })
    }
  }
  writeJsonAtomic(path.join(packageDir, 'event.json'), manifest)
  return {
    success: errors.length === 0,
    exported,
    imported: 0,
    skipped: 0,
    errors,
    eventName: event.name as string
  }
}

export function previewEventPackage(packageDir: string): EventPackagePreview {
  const invalid = (error: string): EventPackagePreview => ({
    valid: false,
    error,
    eventName: '',
    folderName: '',
    photoCount: 0,
    versionCount: 0,
    missingFiles: []
  })
  try {
    const root = path.resolve(packageDir)
    const stat = fs.statSync(root)
    if (!stat.isDirectory()) return invalid('请选择 PhotoPeek 事件文件夹')
    const manifestPath = path.join(root, 'event.json')
    if (!fs.existsSync(manifestPath)) return invalid('未找到 event.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (manifest.format !== 'photopeek-event' || manifest.kind !== 'event')
      return invalid('这不是有效的 PhotoPeek 事件包')
    if (manifest.formatVersion !== 1)
      return invalid(`不支持的事件包版本: ${manifest.formatVersion}`)
    const event = manifest.event || manifest
    const photos = manifest.photos && typeof manifest.photos === 'object' ? manifest.photos : {}
    const missingFiles: string[] = []
    let versionCount = 0
    for (const photo of Object.values(photos) as any[]) {
      for (const version of photo.versions || []) {
        versionCount++
        const relativePath = version.relativePath || version.fileName
        const source = safeRelativePath(root, relativePath)
        if (!source || !fs.existsSync(source)) missingFiles.push(relativePath)
      }
    }
    return {
      valid: true,
      eventName: String(event.name || ''),
      folderName: String(event.folderName || path.basename(root)),
      photoCount: Object.keys(photos).length,
      versionCount,
      missingFiles
    }
  } catch (error) {
    return invalid(`读取事件包失败: ${(error as Error).message}`)
  }
}

/** Import a validated event package into the active PhotoPeek library. */
export async function importEventPackage(
  packageDir: string,
  sendProgress: (progress: EventPackageProgress) => void
): Promise<EventPackageResult> {
  const preview = previewEventPackage(packageDir)
  if (!preview.valid)
    return {
      success: false,
      exported: 0,
      imported: 0,
      skipped: 0,
      errors: [preview.error || '事件包无效']
    }
  const root = path.resolve(packageDir)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'event.json'), 'utf8'))
  const eventData = manifest.event || manifest
  const db = getDb()
  const newEventId = uuid()
  const newFolderName = ensureUniqueFolderName(
    sanitizeFolderName(preview.folderName) || `导入事件_${Date.now()}`
  )
  const eventDir = getEventDir(newFolderName)
  fs.mkdirSync(eventDir, { recursive: true })
  const copied: string[] = []
  const errors: string[] = []
  let imported = 0
  let current = 0
  const photos = Object.values(manifest.photos || {}) as any[]
  const totalVersions = photos.reduce((sum, photo) => sum + (photo.versions?.length || 0), 0)
  const tagIdMap = new Map<string, string>()
  try {
    db.run('BEGIN')
    db.run(
      `INSERT INTO events (id, name, description, folder_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        newEventId,
        eventData.name || newFolderName,
        eventData.description || '',
        newFolderName,
        eventData.createdAt || new Date().toISOString(),
        eventData.updatedAt || new Date().toISOString()
      ]
    )
    for (const tag of (manifest.tags || []) as any[]) {
      const newTagId = uuid()
      tagIdMap.set(String(tag.id), newTagId)
      db.run('INSERT INTO tags (id, event_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)', [
        newTagId,
        newEventId,
        tag.name || '',
        tag.color || '#6366f1',
        tag.createdAt || new Date().toISOString()
      ])
    }
    sendProgress({ current: 0, total: totalVersions, message: '准备导入事件...', percent: 0 })
    for (const photo of photos) {
      const versions = [...(photo.versions || [])].sort(
        (a, b) => (a.order ?? 999999) - (b.order ?? 999999)
      )
      const available = versions.filter((version) => {
        const source = safeRelativePath(root, version.relativePath || version.fileName)
        return !!source && fs.existsSync(source)
      })
      if (available.length === 0) {
        errors.push(`${photo.fileName || '未命名照片'}: 没有可用版本`)
        continue
      }
      const original = available.find((version) => version.isOriginal) || available[0]
      const photoId = uuid()
      let photoPath = ''
      let photoFileName = ''
      let photoSize = 0
      const storedPaths = new Map<any, string>()
      for (const version of available) {
        current++
        const source = safeRelativePath(root, version.relativePath || version.fileName)!
        const destination = uniqueFilePath(eventDir, safeFileName(version.fileName || source))
        fs.copyFileSync(source, destination)
        copied.push(destination)
        storedPaths.set(version, destination)
        const stats = fs.statSync(destination)
        const isOriginal = version === original
        if (isOriginal) {
          photoPath = destination
          photoFileName = path.basename(destination)
          photoSize = stats.size
        }
        sendProgress({
          current,
          total: totalVersions,
          message: `正在导入: ${version.fileName}`,
          percent: Math.round((current / Math.max(totalVersions, 1)) * 100)
        })
      }
      const metadata = photo.metadata ? JSON.stringify(photo.metadata) : null
      db.run(
        `INSERT INTO photos (id, event_id, file_path, file_name, file_size, width, height, rating, flag, color_label, is_edited, needs_edit, metadata, original_metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          photoId,
          newEventId,
          photoPath,
          photoFileName,
          photoSize,
          photo.width || 0,
          photo.height || 0,
          photo.rating || 0,
          photo.flag || null,
          photo.colorLabel || null,
          photo.isEdited ? 1 : 0,
          photo.needsEdit ? 1 : 0,
          metadata,
          photo.originalMetadata ? JSON.stringify(photo.originalMetadata) : null,
          photo.createdAt || new Date().toISOString(),
          photo.updatedAt || new Date().toISOString()
        ]
      )
      for (const version of available) {
        const storedPath = storedPaths.get(version) as string
        const versionId = uuid()
        let thumbPath: string | null = null
        try {
          thumbPath = await generateThumbnail(storedPath, versionId, newEventId, newFolderName)
        } catch (error) {
          errors.push(`${version.fileName}: 缩略图生成失败`)
        }
        db.run(
          `INSERT INTO photo_versions (id, photo_id, version_name, file_path, file_name, file_size, width, height, thumbnail_path, metadata, is_original, uploaded_by, uploaded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            versionId,
            photoId,
            version.versionName || '原始文件',
            storedPath,
            path.basename(storedPath),
            fs.statSync(storedPath).size,
            version.width || 0,
            version.height || 0,
            thumbPath,
            version.metadata ? JSON.stringify(version.metadata) : null,
            version === original ? 1 : 0,
            version.uploadedBy || null,
            version.uploadedAt || null,
            version.createdAt || new Date().toISOString()
          ]
        )
      }
      for (const oldTagId of photo.tags || []) {
        const newTagId = tagIdMap.get(String(oldTagId))
        if (newTagId)
          db.run('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)', [
            photoId,
            newTagId
          ])
      }
      imported++
    }
    db.run(
      'UPDATE photos SET thumbnail_path = (SELECT v.thumbnail_path FROM photo_versions v WHERE v.photo_id = photos.id AND v.thumbnail_path IS NOT NULL ORDER BY v.is_original DESC, v.created_at ASC LIMIT 1) WHERE event_id = ?',
      [newEventId]
    )
    // Write the local manifest while the transaction is still open so any
    // filesystem failure can roll back the database and staged files.
    writeEventMetadata(newEventId, newFolderName, {
      name: eventData.name || newFolderName,
      description: eventData.description || '',
      createdAt: eventData.createdAt || new Date().toISOString(),
      updatedAt: eventData.updatedAt || new Date().toISOString()
    })
    syncEventJsonPhotos(newEventId)
    db.run('COMMIT')
    persistDatabase()
    return {
      success: errors.length === 0,
      exported: 0,
      imported,
      skipped: 0,
      errors,
      eventId: newEventId,
      eventName: eventData.name || newFolderName
    }
  } catch (error) {
    try {
      db.run('ROLLBACK')
    } catch {}
    for (const file of copied) {
      try {
        fs.unlinkSync(file)
      } catch {}
    }
    try {
      fs.rmSync(eventDir, { recursive: true, force: true })
    } catch {}
    return {
      success: false,
      exported: 0,
      imported,
      skipped: 0,
      errors: [...errors, (error as Error).message]
    }
  }
}

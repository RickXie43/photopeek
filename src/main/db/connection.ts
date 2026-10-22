import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import { join, resolve, isAbsolute, dirname } from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { exportDatabase } from './export'
import { repairTagIntegrity, type TagRepairResult } from '../services/tag.service'
import { withPersistedTags } from '../services/tag-persistence.service'
import {
  getDbPath,
  getLibraryPath,
  initializeLibrary,
  ensureLibraryStructure,
  updateLibraryPath
} from '../services/library.service'

let db: SqlJsDatabase | null = null
let dbPath: string = ''
let sql: Awaited<ReturnType<typeof initSqlJs>> | null = null

function getSqlJsWasmDir(): string {
  if (!app.isPackaged) return join(__dirname, '../../node_modules/sql.js/dist/')
  const unpacked = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'sql.js',
    'dist'
  )
  if (fs.existsSync(unpacked)) return unpacked
  // Kept for older builds that did not unpack sql.js yet.
  return join(app.getAppPath(), 'node_modules', 'sql.js', 'dist')
}

function rebasePhotoPaths(database: SqlJsDatabase, libraryPath: string): number {
  let changed = 0
  const events = new Map<string, string>()
  for (const row of database.exec('SELECT id, folder_name, name FROM events')[0]?.values || []) {
    const id = String(row[0])
    const folderName = String(row[1] || row[2] || id).trim()
    events.set(id, folderName)
  }

  const photos = database.exec(
    'SELECT id, event_id, file_path, file_name FROM photos WHERE deleted_at IS NULL'
  )[0]
  for (const row of photos?.values || []) {
    const [id, eventId, oldPath, fileName] = row.map(String)
    const folderName = events.get(eventId)
    if (!folderName || !fileName) continue
    const nextPath = join(libraryPath, 'events', folderName, fileName)
    // Prefer the file in the active library whenever it exists. The previous
    // library may still be present, so checking only whether oldPath exists
    // leaves paths pointing at the wrong library after a folder switch.
    if (oldPath !== nextPath && (fs.existsSync(nextPath) || !fs.existsSync(oldPath))) {
      database.run('UPDATE photos SET file_path = ?, thumbnail_path = NULL WHERE id = ?', [
        nextPath,
        id
      ])
      changed++
    }
  }

  const versions = database.exec(`
    SELECT v.id, v.photo_id, v.file_path, v.file_name, v.thumbnail_path, p.event_id
    FROM photo_versions v JOIN photos p ON p.id = v.photo_id
    WHERE p.deleted_at IS NULL
  `)[0]
  for (const row of versions?.values || []) {
    const [id, photoId, oldPath, fileName, oldThumb, eventId] = row.map(String)
    const folderName = events.get(eventId)
    if (!folderName || !fileName) continue
    const nextPath = join(libraryPath, 'events', folderName, fileName)
    const nextThumb = join(libraryPath, 'thumbnails', folderName, `${id}.jpg`)
    const pathChanged = oldPath !== nextPath && (fs.existsSync(nextPath) || !fs.existsSync(oldPath))
    // Thumbnail paths are library-local cache paths. Always rebase them when
    // switching libraries, even if the old cache file still exists elsewhere;
    // otherwise a portable copy can keep pointing at an unreachable machine
    // and the renderer will never trigger regeneration.
    const thumbChanged = oldThumb !== nextThumb
    if (pathChanged || thumbChanged) {
      database.run('UPDATE photo_versions SET file_path = ?, thumbnail_path = ? WHERE id = ?', [
        nextPath,
        nextThumb,
        id
      ])
      changed++
    }
    // Keep the parent row in sync with the version that will be selected.
    database.run('UPDATE photos SET thumbnail_path = NULL WHERE id = ?', [photoId])
  }
  return changed
}

export async function getDatabase(): Promise<SqlJsDatabase> {
  if (db) return db

  // Initialize library (creates folder structure)
  initializeLibrary()
  dbPath = getDbPath()

  const wasmDir = getSqlJsWasmDir()

  const SQL = await initSqlJs({
    locateFile: (file: string) => join(wasmDir, file)
  })
  sql = SQL

  // Load existing DB from file or create new one
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath)
    db = new SQL.Database(buffer)
    console.log(`Loaded database from: ${dbPath}`)
  } else {
    db = new SQL.Database()
    console.log(`Created new database at: ${dbPath}`)
  }

  db.run('PRAGMA journal_mode=WAL')
  db.run('PRAGMA foreign_keys=ON')
  await createTables(db)
  repairTagsWithBackup(db, dbPath)
  const rebased = rebasePhotoPaths(db, getLibraryPath())
  if (rebased > 0) console.log(`[Library] Rebased ${rebased} photo/version paths on startup`)
  // Save initial schema
  persistDatabase()
  return db
}

export function persistDatabase(): void {
  if (!db || !dbPath) return
  try {
    ensureLibraryStructure()
    const data = exportDatabase(db)
    fs.writeFileSync(dbPath + '.tmp', Buffer.from(data))
    fs.renameSync(dbPath + '.tmp', dbPath)
  } catch (err) {
    console.error('Failed to persist database:', err)
    throw err
  }
}

function repairTagsWithBackup(database: SqlJsDatabase, filePath: string, eventId?: string): TagRepairResult {
  const result = repairTagIntegrity(database, eventId, () => {
    const backupDir = join(dirname(filePath), 'backups', 'tag-repair')
    fs.mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = join(backupDir, `photopeek-${stamp}-${randomUUID()}.db`)
    fs.writeFileSync(backupPath, Buffer.from(exportDatabase(database)), { flag: 'wx' })
    console.log(`[Tags] Saved pre-repair backup: ${backupPath}`)
  })
  if (result.changed) console.log('[Tags] Automatically repaired tag integrity:', result)
  return result
}

/** Called on event entry and before tag mutations, as well as on library startup/switch. */
export function repairDatabaseTags(eventId?: string): TagRepairResult {
  const database = getDb()
  let result: TagRepairResult
  return withPersistedTags(database, () => {
    result = repairTagsWithBackup(database, dbPath, eventId)
    return result
  }, () => {
    if (result.changed) persistDatabase()
  })
}

function createTables(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      folder_name TEXT NOT NULL DEFAULT '',
      cover_photo_id TEXT,      deleted_at TEXT DEFAULT NULL,      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Add folder_name column if missing (for existing databases)
  try {
    db.run("ALTER TABLE events ADD COLUMN folder_name TEXT NOT NULL DEFAULT ''")
  } catch {}
  // Add deleted_at column for soft delete / trash feature on events
  try {
    db.run('ALTER TABLE events ADD COLUMN deleted_at TEXT DEFAULT NULL')
  } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      rating INTEGER DEFAULT 0,
      flag TEXT DEFAULT NULL,
      color_label TEXT DEFAULT NULL,
      is_edited INTEGER DEFAULT 0,
      needs_edit INTEGER DEFAULT 0,
      thumbnail_path TEXT,
      metadata TEXT,
      original_metadata TEXT,
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Add deleted_at column for soft delete / trash feature on photos (for existing databases)
  try {
    db.run('ALTER TABLE photos ADD COLUMN deleted_at TEXT DEFAULT NULL')
  } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS photo_tags (
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (photo_id, tag_id)
    )
  `)

  // Add default_version_id column if missing
  try {
    db.run('ALTER TABLE photos ADD COLUMN default_version_id TEXT DEFAULT NULL')
  } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS photo_versions (
      id              TEXT PRIMARY KEY,
      photo_id        TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      version_name    TEXT NOT NULL,
      file_path       TEXT NOT NULL,
      file_name       TEXT NOT NULL,
      file_size       INTEGER NOT NULL DEFAULT 0,
      width           INTEGER DEFAULT 0,
      height          INTEGER DEFAULT 0,
      thumbnail_path  TEXT,
      metadata        TEXT,
      is_original     INTEGER DEFAULT 0,
      uploaded_by     TEXT DEFAULT NULL,
      uploaded_at     TEXT DEFAULT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.run(`CREATE INDEX IF NOT EXISTS idx_photo_versions_photo ON photo_versions(photo_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_photos_event ON photos(event_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_photos_rating ON photos(rating)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_photos_flag ON photos(flag)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_tags_event ON tags(event_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_tags_event_name ON tags(event_id, name)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_photo_tags_tag ON photo_tags(tag_id)`)
}

export function getDb(): SqlJsDatabase {
  if (!db) throw new Error('Database not initialized. Call getDatabase() first.')
  return db
}

/** Prepare and validate the destination before committing the active library. */
export function switchDatabase(newPath: string): void {
  if (!newPath.trim() || !isAbsolute(newPath)) throw new Error('请选择有效的绝对目录路径')
  newPath = resolve(newPath)
  if (newPath === getLibraryPath()) return
  if (!sql || !db) throw new Error('数据库尚未初始化')
  const nextPath = join(newPath, 'photopeek.db')
  // Create the destination before touching either database. A user may enter
  // a brand-new folder (or a folder on a removable drive); writing the
  // current database first used to fail with ENOENT when its parent path was
  // not present yet.
  fs.mkdirSync(newPath, { recursive: true })
  fs.mkdirSync(join(newPath, 'events'), { recursive: true })
  fs.mkdirSync(join(newPath, 'thumbnails'), { recursive: true })
  const next = fs.existsSync(nextPath)
    ? new sql.Database(fs.readFileSync(nextPath))
    : new sql.Database()
  let rebased = 0
  try {
    next.run('PRAGMA foreign_keys=ON')
    createTables(next)
    repairTagsWithBackup(next, nextPath)
    rebased = rebasePhotoPaths(next, newPath)
    // A failed save must not silently discard the current library's changes.
    // The active database can itself point to a folder that was removed
    // externally. Recreate its parent so switching libraries remains atomic
    // instead of surfacing "ENOENT ... photopeek.db" to settings:update.
    fs.mkdirSync(dirname(dbPath), { recursive: true })
    fs.writeFileSync(dbPath + '.tmp', Buffer.from(exportDatabase(db)))
    fs.renameSync(dbPath + '.tmp', dbPath)
    fs.writeFileSync(nextPath + '.tmp', Buffer.from(exportDatabase(next)))
    fs.renameSync(nextPath + '.tmp', nextPath)
    updateLibraryPath(newPath)
  } catch (error) {
    next.close()
    throw error
  }
  const previous = db
  db = next
  dbPath = nextPath
  previous.close()
  if (rebased > 0) console.log(`[Library] Rebased ${rebased} photo/version paths for ${newPath}`)
}

export function saveDatabase(): Uint8Array | null {
  if (!db) {
    console.warn('saveDatabase: database not initialized, skipping')
    return null
  }
  persistDatabase()
  return exportDatabase(db)
}

export function closeDatabase(): void {
  if (db) {
    persistDatabase()
    db.close()
    db = null
  }
}

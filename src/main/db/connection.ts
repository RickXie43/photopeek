import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import { join } from 'path'
import * as fs from 'fs'
import { getDbPath, initializeLibrary, ensureLibraryStructure } from '../services/library.service'

let db: SqlJsDatabase | null = null
let dbPath: string = ''

export async function getDatabase(): Promise<SqlJsDatabase> {
  if (db) return db

  // Initialize library (creates folder structure)
  initializeLibrary()
  dbPath = getDbPath()

  const wasmDir = join(__dirname, '../../node_modules/sql.js/dist/')

  const SQL = await initSqlJs({
    locateFile: (file: string) => join(wasmDir, file),
  })

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
  // Save initial schema
  persistDatabase()
  return db
}

export function persistDatabase(): void {
  if (!db || !dbPath) return
  try {
    ensureLibraryStructure()
    const data = db.export()
    fs.writeFileSync(dbPath, Buffer.from(data))
  } catch (err) {
    console.error('Failed to persist database:', err)
  }
}

async function createTables(db: SqlJsDatabase): Promise<void> {
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
  try { db.run('ALTER TABLE events ADD COLUMN folder_name TEXT NOT NULL DEFAULT \'\'') } catch {}
  // Add deleted_at column for soft delete / trash feature on events
  try { db.run('ALTER TABLE events ADD COLUMN deleted_at TEXT DEFAULT NULL') } catch {}

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
  try { db.run('ALTER TABLE photos ADD COLUMN deleted_at TEXT DEFAULT NULL') } catch {}

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
  try { db.run('ALTER TABLE photos ADD COLUMN default_version_id TEXT DEFAULT NULL') } catch {}

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
}

export function getDb(): SqlJsDatabase {
  if (!db) throw new Error('Database not initialized. Call getDatabase() first.')
  return db
}

export function saveDatabase(): Uint8Array | null {
  if (!db) {
    console.warn('saveDatabase: database not initialized, skipping')
    return null
  }
  persistDatabase()
  return db.export()
}

export function closeDatabase(): void {
  if (db) {
    persistDatabase()
    db.close()
    db = null
  }
}

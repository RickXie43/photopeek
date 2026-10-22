import type { Database, SqlValue } from 'sql.js'

interface TableSnapshot {
  table: 'tags' | 'photo_tags'
  columns: string[]
  values: SqlValue[][]
}

function snapshot(db: Database, table: TableSnapshot['table']): TableSnapshot {
  const result = db.exec(`SELECT * FROM ${table}`)[0]
  // sql.js omits the result entirely for an empty table.
  const columns =
    result?.columns || db.exec(`PRAGMA table_info(${table})`)[0].values.map((row) => String(row[1]))
  return {
    table,
    columns,
    values: (result?.values || []).map((row) =>
      row.map((value) => (value instanceof Uint8Array ? value.slice() : value))
    )
  }
}

function restore(db: Database, tags: TableSnapshot, photoTags: TableSnapshot): void {
  // Legacy files may already contain dangling relationships. Replay them
  // exactly, rather than silently deleting extra data while handling an I/O error.
  db.run('PRAGMA foreign_keys=OFF')
  db.run('SAVEPOINT restore_persisted_tags')
  try {
    db.run('DELETE FROM photo_tags; DELETE FROM tags')
    for (const table of [tags, photoTags]) {
      const columns = table.columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(', ')
      const placeholders = table.columns.map(() => '?').join(', ')
      for (const row of table.values) {
        db.run(`INSERT INTO ${table.table} (${columns}) VALUES (${placeholders})`, row)
      }
    }
    db.run('RELEASE restore_persisted_tags')
  } catch (error) {
    db.run('ROLLBACK TO restore_persisted_tags; RELEASE restore_persisted_tags')
    throw error
  } finally {
    db.run('PRAGMA foreign_keys=ON')
  }
}

/**
 * Tag mutations and persistence run synchronously on the main thread.
 * An unsuccessful save must not leave an invisible toggle in memory: otherwise
 * retrying the same key press would perform the opposite operation.
 */
export function withPersistedTags<T>(db: Database, mutate: () => T, persist: () => void): T {
  try {
    const tags = snapshot(db, 'tags')
    const photoTags = snapshot(db, 'photo_tags')
    try {
      const result = mutate()
      persist()
      return result
    } catch (error) {
      try {
        restore(db, tags, photoTags)
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], '标签保存失败，恢复标签状态也失败', {
          cause: error
        })
      }
      throw error
    }
  } finally {
    // A persistence callback may export/reopen the sql.js connection before failing.
    db.run('PRAGMA foreign_keys=ON')
  }
}

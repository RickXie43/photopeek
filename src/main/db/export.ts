import type { Database } from 'sql.js'

/** sql.js export() reopens the connection and resets PRAGMAs. */
export function exportDatabase(database: Database): Uint8Array {
  try {
    return database.export()
  } finally {
    database.run('PRAGMA foreign_keys=ON')
  }
}

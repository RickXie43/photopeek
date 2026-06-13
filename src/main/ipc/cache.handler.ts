import { ipcMain } from 'electron'
import { closeDatabase, getDatabase, persistDatabase } from '../db/connection'
import { getDbPath, getThumbnailsDir, getEventsDir, ensureLibraryStructure } from '../services/library.service'
import * as fs from 'fs'

function rmDirRecursive(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true })
      console.log(`[Cache] Deleted directory: ${dirPath}`)
    } catch (err) {
      console.error(`[Cache] Failed to delete directory ${dirPath}:`, err)
    }
  }
}

export function registerCacheHandlers(): void {
  ipcMain.handle('cache:clear', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      console.log('[Cache] Starting cache clear...')

      // 1. Close database properly
      try {
        persistDatabase()
        closeDatabase()
        console.log('[Cache] Database closed and persisted')
      } catch (err) {
        console.error('[Cache] Error closing database:', err)
      }

      // 2. Delete database file
      const dbPath = getDbPath()
      rmDirRecursive(dbPath)

      // 3. Delete all thumbnails
      const thumbnailsDir = getThumbnailsDir()
      rmDirRecursive(thumbnailsDir)

      // 4. Delete all event photo files (keep events dir, remove contents)
      const eventsDir = getEventsDir()
      rmDirRecursive(eventsDir)

      // 5. Reinitialize library structure and database
      ensureLibraryStructure()
      await getDatabase()
      console.log('[Cache] Database reinitialized')

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Cache] Cache clear failed:', msg)
      return { success: false, error: msg }
    }
  })
}

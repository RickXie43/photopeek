import sharp from 'sharp'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getEventThumbnailsDir } from './library.service'
import { getEventFolderName } from '../ipc/event.handler'

const THUMBNAIL_SIZE = 400
const THUMBNAIL_QUALITY = 75

/**
 * Check if a file path contains non-ASCII characters.
 * sharp/libvips on Windows can have issues with Unicode paths.
 */
function hasNonAsciiChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) return true
  }
  return false
}

/**
 * Ensure a file path uses only ASCII characters by copying to a temp path if needed.
 * sharp on Windows may fail to open files with Unicode characters in the path.
 */
function ensureAsciiPath(filePath: string): { path: string; cleanup: () => void } {
  if (!hasNonAsciiChars(filePath)) {
    return { path: filePath, cleanup: () => {} }
  }

  const ext = path.extname(filePath)
  const tempDir = os.tmpdir()
  const tempName = `photopeek_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`
  const tempPath = path.join(tempDir, tempName)

  try {
    fs.copyFileSync(filePath, tempPath)
    console.log(`[Thumbnail] Copied Unicode path to temp ASCII path: ${tempPath}`)
    return {
      path: tempPath,
      cleanup: () => {
        try { fs.unlinkSync(tempPath) } catch {}
      },
    }
  } catch (err) {
    console.error(`[Thumbnail] Failed to copy to temp path:`, err)
    return { path: filePath, cleanup: () => {} }
  }
}

export async function generateThumbnail(
  sourcePath: string,
  photoId: string,
  eventId: string,
  folderName?: string
): Promise<string | null> {
  let tempHandle: { path: string; cleanup: () => void } | null = null
  try {
    const name = folderName || getEventFolderName(eventId)
    const dir = getEventThumbnailsDir(name)
    fs.mkdirSync(dir, { recursive: true })

    const thumbName = `${photoId}.jpg`
    const thumbPath = path.join(dir, thumbName)

    // Skip if thumbnail already exists
    if (fs.existsSync(thumbPath)) return thumbPath

    // Use ASCII-safe path for sharp (workaround for Unicode path issues on Windows)
    tempHandle = ensureAsciiPath(sourcePath)
    const safePath = tempHandle.path

    await sharp(safePath)
      .rotate() // Auto-rotate based on EXIF orientation
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toFile(thumbPath)

    return thumbPath
  } catch (err) {
    console.error(`Failed to generate thumbnail for ${sourcePath}:`, err)
    return null
  } finally {
    tempHandle?.cleanup()
  }
}

export async function batchGenerateThumbnails(
  files: Array<{ sourcePath: string; photoId: string }>,
  eventId: string,
  folderName?: string
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>()

  // Process in parallel with concurrency limit
  const concurrency = 4
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency)
    const promises = batch.map((f) => generateThumbnail(f.sourcePath, f.photoId, eventId, folderName))
    const thumbnails = await Promise.all(promises)
    batch.forEach((f, idx) => results.set(f.photoId, thumbnails[idx]))
  }

  return results
}

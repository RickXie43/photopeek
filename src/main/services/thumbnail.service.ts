import sharp from 'sharp'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import exifr from 'exifr'
import { getEventThumbnailsDir } from './library.service'
import { getEventFolderName } from '../ipc/event.handler'

const THUMBNAIL_SIZE = 400
const THUMBNAIL_QUALITY = 75

/** RAW file extensions that need embedded JPEG extraction */
const RAW_EXTENSIONS = new Set(['.cr2', '.cr3', '.nef', '.arw', '.rw2', '.orf', '.raf', '.dng', '.raw', '.srf', '.sr2'])

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

    let pipeline = sharp()

    if (RAW_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
      // Extract embedded JPEG preview from RAW file via exifr
      // Many cameras embed a full-size JPEG inside RAW (CR2, NEF, ARW, etc.)
      try {
        console.log(`[Thumbnail] Extracting embedded JPEG from RAW: ${path.basename(sourcePath)}`)
        const thumbData: ArrayBuffer | null = await exifr.thumbnail(safePath)
        if (thumbData) {
          const buf = Buffer.from(thumbData)
          pipeline = sharp(buf)
        } else {
          // Fallback: try sharp directly (may fail for some RAW but worth a try)
          pipeline = sharp(safePath)
        }
      } catch (err) {
        console.log(`[Thumbnail] exifr extraction failed, trying sharp directly:`, err)
        pipeline = sharp(safePath)
      }
    } else {
      pipeline = sharp(safePath)
    }

    await pipeline
      .rotate() // Auto-rotate based on EXIF orientation
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toFile(thumbPath)

    console.log(`[Thumbnail] Generated: ${thumbName} from ${path.basename(sourcePath)}`)
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

/** Extract embedded JPEG preview from a RAW file (CR2, NEF, ARW, etc.) */
export async function getRawPreviewBuffer(filePath: string): Promise<Buffer | null> {
  const ext = path.extname(filePath).toLowerCase()
  if (!RAW_EXTENSIONS.has(ext)) {
    try { return await sharp(filePath).jpeg().toBuffer() } catch { return null }
  }
  try {
    // exifr.thumbnail() extracts the embedded preview JPEG — size varies by camera
    const thumbData = await exifr.thumbnail(filePath)
    if (thumbData) {
      const buf = Buffer.from(thumbData)
      // Check if the embedded preview is large enough (>500px on longest side)
      try {
        const meta = await sharp(buf).metadata()
        const maxDim = Math.max(meta.width || 0, meta.height || 0)
        console.log(`[RawPreview] exifr returned ${meta.width}×${meta.height} for ${path.basename(filePath)}`)
        if (maxDim >= 500) return buf
        // Too small — fall through to try sharp or other methods
        console.log(`[RawPreview] Embedded preview too small (${maxDim}px), trying fallback`)
      } catch {
        // Can't determine size, use it anyway
        return buf
      }
    }
    // Fallback: try sharp directly (may work for some RAW formats)
    try {
      const directBuf = await sharp(filePath).jpeg().toBuffer()
      console.log(`[RawPreview] sharp direct succeeded for ${path.basename(filePath)}`)
      return directBuf
    } catch {}
    // Last resort: try exifr.parse with thumbnail option (different extraction path)
    try {
      const parsed = await exifr.parse(filePath, { thumbnail: true } as any) as any
      if (parsed?.thumbnail) {
        const buf2 = Buffer.from(parsed.thumbnail)
        console.log(`[RawPreview] exifr.parse thumbnail fallback: ${buf2.length / 1024}KB for ${path.basename(filePath)}`)
        return buf2
      }
    } catch {}
    return null
  } catch {
    return null
  }
}

/** Get native image dimensions from a RAW file via EXIF data */
export async function getRawDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
  try {
    // Parse all tags (no pick filter) to find any width/height tags
    const meta = await exifr.parse(filePath)
    if (meta) {
      // Try all common key variations
      const w = (meta as any).ImageWidth || (meta as any).imageWidth ||
                (meta as any).ImageWidth || (meta as any).Width ||
                (meta as any).width || (meta as any).ExifImageWidth ||
                (meta as any).exifImageWidth
      const h = (meta as any).ImageHeight || (meta as any).imageHeight ||
                (meta as any).ImageHeight || (meta as any).Height ||
                (meta as any).height || (meta as any).ExifImageHeight ||
                (meta as any).exifImageHeight
      if (w && h) return { width: Number(w), height: Number(h) }
    }
    // Fallback: try sharp
    const s = await sharp(filePath).metadata()
    if (s.width && s.height) return { width: s.width, height: s.height }
    // Last resort: try getting dimensions from the embedded thumbnail
    const thumbBuf = await getRawPreviewBuffer(filePath)
    if (thumbBuf) {
      const s2 = await sharp(thumbBuf).metadata()
      if (s2.width && s2.height) return { width: s2.width, height: s2.height }
    }
    return null
  } catch {
    return null
  }
}

const MEDIUM_SIZE = 1200
const MEDIUM_QUALITY = 65
const LARGE_SIZE = 2600
const LARGE_QUALITY = 80

async function resizeWithSharp(
  sourcePath: string,
  maxSize: number,
  quality: number,
  cacheDir: string,
  cacheKey: string,
): Promise<Buffer | null> {
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    const cachePath = path.join(cacheDir, cacheKey + '_' + maxSize + '.jpg')
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath)
    }

    let pipeline = sharp()
    const ext = path.extname(sourcePath).toLowerCase()

    if (RAW_EXTENSIONS.has(ext)) {
      const rawBuf = await getRawPreviewBuffer(sourcePath)
      if (!rawBuf) return null
      pipeline = sharp(rawBuf)
    } else {
      pipeline = sharp(sourcePath)
    }

    const buf = await pipeline
      .rotate()
      .resize(maxSize, maxSize, { fit: 'inside' })
      .jpeg({ quality })
      .toBuffer()

    fs.writeFile(cachePath, buf, () => {})
    return buf
  } catch (err) {
    console.error(`[Thumbnail] resizeWithSharp failed for ${sourcePath}:`, err)
    return null
  }
}

/** Generate a medium-quality JPEG (1200px) with RAW support */
export async function generateMedium(
  sourcePath: string,
  cacheDir: string,
  cacheKey: string,
): Promise<Buffer | null> {
  return resizeWithSharp(sourcePath, MEDIUM_SIZE, MEDIUM_QUALITY, cacheDir, cacheKey)
}

/** Generate a large preview (2600px, higher quality) for LoupeView / photo:// protocol */
export async function generateLargePreview(
  sourcePath: string,
): Promise<Buffer | null> {
  const cacheDir = path.join(require('os').tmpdir(), 'photopeek-large-preview')
  return resizeWithSharp(sourcePath, LARGE_SIZE, LARGE_QUALITY, cacheDir, path.basename(sourcePath))
}

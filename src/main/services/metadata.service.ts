import exifr from 'exifr'
import sharp from 'sharp'
import type { PhotoMetadata } from '../../renderer/src/types/photo'

export async function parseMetadata(filePath: string): Promise<PhotoMetadata | null> {
  try {
    const output = await exifr.parse(filePath, {
      pick: [
        'DateTimeOriginal',
        'Make',
        'Model',
        'LensModel',
        'FocalLength',
        'FNumber',
        'ExposureTime',
        'ISO',
        'GPSLatitude',
        'GPSLongitude',
        'GPSAltitude',
        'Orientation',
        'ImageWidth',
        'ImageHeight',
        'FileType',
      ],
      // translateKeys translates EXIF tag names to camelCase (e.g. "DateTimeOriginal" → "dateTimeOriginal")
      translateKeys: true,
    })

    const result: PhotoMetadata = {}

    if (output) {
      console.log('[Metadata] exifr output keys:', Object.keys(output))
      // translateKeys: true returns PascalCase keys (e.g. "Make", "Model", "DateTimeOriginal")
      if (output.Make) result.cameraMake = output.Make
      if (output.Model) result.cameraModel = output.Model
      if (output.DateTimeOriginal) {
        // exifr with translateKeys may return a Date object — convert to string
        result.dateTimeOriginal = output.DateTimeOriginal instanceof Date
          ? output.DateTimeOriginal.toISOString()
          : String(output.DateTimeOriginal)
      }
      if (output.LensModel) result.lensModel = output.LensModel
      if (output.FocalLength != null) result.focalLength = String(output.FocalLength)
      if (output.FNumber != null) result.aperture = String(output.FNumber)
      if (output.ExposureTime != null) result.shutterSpeed = String(output.ExposureTime)
      if (output.ISO) result.iso = output.ISO
      if (output.GPSLatitude) result.gpsLatitude = output.GPSLatitude
      if (output.GPSLongitude) result.gpsLongitude = output.GPSLongitude
      if (output.GPSAltitude) result.gpsAltitude = output.GPSAltitude
      if (output.ImageWidth) result.imageWidth = output.ImageWidth
      if (output.ImageHeight) result.imageHeight = output.ImageHeight
      if (output.FileType) result.fileType = output.FileType
      if (output.Orientation) result.orientation = output.Orientation
    } else {
      console.log('[Metadata] exifr returned null for:', filePath)
    }

    // Fallback: use sharp to get image dimensions (more reliable than EXIF)
    if (!result.imageWidth || !result.imageHeight) {
      try {
        const sharpMeta = await sharp(filePath).metadata()
        if (sharpMeta.width) result.imageWidth = sharpMeta.width
        if (sharpMeta.height) result.imageHeight = sharpMeta.height
      } catch {
        // For RAW files where sharp fails, try getting dimensions from EXIF directly
        const { getRawDimensions } = await import('./thumbnail.service')
        const dims = await getRawDimensions(filePath)
        if (dims) {
          result.imageWidth = dims.width
          result.imageHeight = dims.height
        }
      }
    }

    // Return null if nothing was parsed
    if (Object.keys(result).length === 0) return null
    return result
  } catch (err) {
    console.error(`Failed to parse metadata for ${filePath}:`, err)
    return null
  }
}

export async function parseMetadataBatch(filePaths: string[]): Promise<Map<string, PhotoMetadata | null>> {
  const results = new Map<string, PhotoMetadata | null>()
  const chunkSize = 10
  for (let i = 0; i < filePaths.length; i += chunkSize) {
    const chunk = filePaths.slice(i, i + chunkSize)
    const promises = chunk.map(async (path) => {
      const meta = await parseMetadata(path)
      results.set(path, meta)
    })
    await Promise.all(promises)
  }
  return results
}

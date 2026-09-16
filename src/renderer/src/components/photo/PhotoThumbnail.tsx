import React, { useEffect, useState } from 'react'
import { cn } from '../../lib/cn'
import { ImageIcon } from 'lucide-react'

export function PhotoThumbnail({
  src,
  alt,
  photoId,
  className,
}: {
  src: string
  alt: string
  photoId: string
  className?: string
}): React.JSX.Element {
  const [loadFailed, setLoadFailed] = useState(false)
  const [base64Src, setBase64Src] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  // A repair may update the stored thumbnail path while the same photo tile
  // stays mounted. Reset failed-image state whenever its source changes so
  // the newly generated cache file is retried instead of leaving a placeholder.
  useEffect(() => {
    setLoadFailed(false)
    setBase64Src(null)
    setRetryNonce(0)
  }, [src])

  useEffect(() => {
    return window.electron.ipcRenderer.on(
      'photos:thumbnails-repaired',
      (...args: unknown[]) => {
        const [, eventId, repairedPhotoId] = args
        if (repairedPhotoId === photoId || eventId === '__all__') {
          setLoadFailed(false)
          setBase64Src(null)
          setRetryNonce((value) => value + 1)
        }
      }
    )
  }, [photoId])

  const handleError = async (): Promise<void> => {
    if (loadFailed) return
    setLoadFailed(true)

    // A browser error can mean the cache file is corrupt, not just absent.
    // Force a repair first so copied databases and stale cache paths heal
    // as soon as the failed thumbnail is encountered.
    try {
      if (window.electron?.ipcRenderer) {
        const photoUrl = new URL(src)
        let decodedPath = decodeURIComponent(photoUrl.pathname)
        if (/^[a-z]$/i.test(photoUrl.hostname)) {
          decodedPath = `${photoUrl.hostname}:${decodedPath}`
        } else if (/^\/[a-z]:\//i.test(decodedPath)) {
          decodedPath = decodedPath.slice(1)
        }
        const regenerated = (await window.electron.ipcRenderer.invoke(
          'thumbnail:regenerateFromPath',
          decodedPath,
          true
        )) as boolean
        if (regenerated) {
          const repairedData = (await window.electron.ipcRenderer.invoke(
            'image:readBase64',
            decodedPath
          )) as string | null
          if (repairedData) {
            setBase64Src(repairedData)
            return
          }
        }

        // Fallback for ordinary image files that do not have a DB row.
        const dataUrl = (await window.electron.ipcRenderer.invoke(
          'image:readBase64',
          decodedPath
        )) as string | null
        if (dataUrl) {
          setBase64Src(dataUrl)
          return
        }
      }
    } catch {
      // Silently fail
    }
  }

  if (base64Src) {
    return (
      <img
        src={base64Src}
        alt={alt}
        className={cn('w-full h-full object-cover', className)}
      />
    )
  }

  if (loadFailed) {
    return (
      <div className={cn('w-full h-full flex flex-col items-center justify-center bg-gray-100 dark:bg-gray-800 text-gray-400', className)}>
        <ImageIcon size={24} className="mb-1 opacity-50" />
        <span className="text-[10px] opacity-60">{alt.split('.').pop()?.toUpperCase() || 'IMG'}</span>
      </div>
    )
  }

  return (
    <img
      src={`${src}${src.includes('?') ? '&' : '?'}__thumb_retry=${retryNonce}`}
      alt={alt}
      className={cn('w-full h-full object-cover', className)}
      loading="lazy"
      onError={handleError}
    />
  )
}

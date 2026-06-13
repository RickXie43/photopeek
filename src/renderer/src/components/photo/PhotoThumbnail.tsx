import React, { useState } from 'react'
import { cn } from '../../lib/cn'
import { ImageIcon } from 'lucide-react'

export function PhotoThumbnail({
  src,
  alt,
  className,
}: {
  src: string
  alt: string
  className?: string
}): React.JSX.Element {
  const [loadFailed, setLoadFailed] = useState(false)
  const [base64Src, setBase64Src] = useState<string | null>(null)

  const handleError = async (): Promise<void> => {
    if (loadFailed) return
    setLoadFailed(true)

    // Try loading via IPC as base64
    try {
      if (window.electron?.ipcRenderer) {
        const filePath = src.replace('photo://', '')
        const decodedPath = decodeURIComponent(filePath)
        const dataUrl = await window.electron.ipcRenderer.invoke('image:readBase64', decodedPath) as string | null
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
      src={src}
      alt={alt}
      className={cn('w-full h-full object-cover', className)}
      loading="lazy"
      onError={handleError}
    />
  )
}

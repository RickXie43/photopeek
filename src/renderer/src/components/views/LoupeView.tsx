import React, { useState, useEffect, useCallback } from 'react'
import { usePhotoStore } from '../../stores/photoStore'
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Tag } from 'lucide-react'

export function LoupeView({
  onClose,
}: {
  onClose: () => void
}): React.JSX.Element {
  const { photos, selectedPhotoIds, selectPhoto } = usePhotoStore()
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [photoTags, setPhotoTags] = useState<Record<string, { id: string; name: string; color: string }[]>>({})
  const [eventTags, setEventTags] = useState<{ id: string; name: string; color: string }[]>([])
  const [tagMenuOpen, setTagMenuOpen] = useState(false)

  const selectedId = Array.from(selectedPhotoIds)[0]
  const currentIndex = photos.findIndex((p) => p.id === selectedId)
  const photo = currentIndex >= 0 ? photos[currentIndex] : null

  // Load tags for the current photo and event
  useEffect(() => {
    if (!photo) return
    const loadTags = async (): Promise<void> => {
      try {
        const [ptags, etags] = await Promise.all([
          window.electron.ipcRenderer.invoke('tags:listForPhoto', photo.id) as Promise<{ id: string; name: string; color: string }[]>,
          window.electron.ipcRenderer.invoke('tags:list', photo.eventId) as Promise<{ id: string; name: string; color: string }[]>,
        ])
        setPhotoTags((prev) => ({ ...prev, [photo.id]: ptags }))
        setEventTags(etags)
      } catch {}
    }
    loadTags()
  }, [photo?.id, photo?.eventId])

  const currentTags = photo ? photoTags[photo.id] || [] : []
  const defaultTagId = eventTags.length > 0 ? eventTags[0].id : null

  const toggleDefaultTag = useCallback(async (): Promise<void> => {
    if (!photo || !defaultTagId) return
    try {
      const res = await window.electron.ipcRenderer.invoke('tags:toggleOnPhoto', {
        photoId: photo.id,
        tagId: defaultTagId,
        eventId: photo.eventId,
      }) as { hasTag: boolean }
      const newTags = res.hasTag
        ? [...currentTags, eventTags.find(t => t.id === defaultTagId)!]
        : currentTags.filter(t => t.id !== defaultTagId)
      setPhotoTags((prev) => ({ ...prev, [photo.id]: newTags }))
      window.dispatchEvent(new Event('refresh-tags'))
    } catch {}
  }, [photo, defaultTagId, currentTags, eventTags])

  // Navigate to photo by index
  const goTo = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(photos.length - 1, index))
      selectPhoto(photos[clamped].id)
      setZoom(1)
      setPan({ x: 0, y: 0 })
      setTagMenuOpen(false)
    },
    [photos, selectPhoto]
  )

  // Keyboard navigation + tag toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { goTo(currentIndex - 1); return }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { goTo(currentIndex + 1); return }
      if (e.key === ' ' || e.key === 'Space') {
        e.preventDefault()
        if (eventTags.length > 0) {
          toggleDefaultTag()
        } else {
          setZoom(z => z === 1 ? 2 : 1)
          setPan({ x: 0, y: 0 })
        }
        return
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        setTagMenuOpen(v => !v)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [currentIndex, goTo, onClose, eventTags, toggleDefaultTag])

  if (!photo) {
    return (
      <div className="flex-1 flex items-center justify-center bg-black/5">
        <div className="text-gray-400 text-sm">未选择照片</div>
      </div>
    )
  }

  const handleWheel = (e: React.WheelEvent): void => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.25 : 0.25
    setZoom((z) => Math.max(0.25, Math.min(5, z + delta)))
  }

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (zoom > 1) {
      setDragging(true)
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
    }
  }

  const handleMouseMove = (e: React.MouseEvent): void => {
    if (dragging && zoom > 1) {
      setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y })
    }
  }

  const handleMouseUp = (): void => setDragging(false)

  const toggleZoom = (): void => {
    setZoom((z) => (z === 1 ? 2 : 1))
    setPan({ x: 0, y: 0 })
  }

  // Convert Windows path to photo:/// URL
  const toPhotoUrl = (p: string): string => `photo:///${p.replace(/\\/g, '/')}`
  const src = toPhotoUrl(photo.thumbnailPath || photo.filePath)

  return (
    <div className="flex-1 flex flex-col bg-[#1a1a1a]">
      {/* Loupe toolbar */}
      <div className="h-10 flex items-center justify-between px-4 bg-black/40 text-gray-300 shrink-0">
        <div className="flex items-center gap-3 text-xs">
          <button onClick={onClose} className="hover:text-white transition-colors flex items-center gap-1">
            <X size={16} /> 关闭
          </button>
          <span>{photo.fileName}</span>
          {/* Tag chips in toolbar */}
          {currentTags.map(tag => (
            <span
              key={tag.id}
              className="px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{ backgroundColor: tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.19)'), color: tag.color }}
            >
              {tag.name}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">
            {currentIndex + 1} / {photos.length}
          </span>
          <button
            onClick={() => setTagMenuOpen(v => !v)}
            className="hover:text-white transition-colors flex items-center gap-1"
            title="标签 (T)"
          >
            <Tag size={14} />
            <span className="text-gray-400">{currentTags.length}</span>
          </button>
          <button
            onClick={toggleZoom}
            className="hover:text-white transition-colors"
            title="切换放大"
          >
            {zoom === 1 ? <ZoomIn size={16} /> : <ZoomOut size={16} />}
          </button>
          <span className="text-gray-500">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      {/* Tag menu dropdown */}
      {tagMenuOpen && (
        <div className="absolute top-10 right-4 z-50 bg-[#2a2a2a] border border-gray-600 rounded-lg shadow-xl p-2 min-w-[160px]">
          <div className="text-[10px] text-gray-400 px-2 pb-1">选择标签</div>
          {eventTags.length === 0 ? (
            <div className="text-xs text-gray-500 px-2 py-1">暂无标签</div>
          ) : (
            eventTags.map(tag => {
              const hasTag = currentTags.some(t => t.id === tag.id)
              return (
                <button
                  key={tag.id}
                  onClick={async () => {
                    try {
                      const res = await window.electron.ipcRenderer.invoke('tags:toggleOnPhoto', {
                        photoId: photo.id,
                        tagId: tag.id,
                        eventId: photo.eventId,
                      }) as { hasTag: boolean }
                      const newTags = res.hasTag
                        ? [...currentTags, tag]
                        : currentTags.filter(t => t.id !== tag.id)
                      setPhotoTags((prev) => ({ ...prev, [photo.id]: newTags }))
                      window.dispatchEvent(new Event('refresh-tags'))
                    } catch {}
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-white/10 text-left"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="flex-1 text-gray-200">{tag.name}</span>
                  {hasTag && <span className="text-[#34C759]">✓</span>}
                </button>
              )
            })
          )}
        </div>
      )}

      {/* Image area */}
      <div
        className="flex-1 flex items-center justify-center overflow-hidden relative"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={toggleZoom}
        style={{ cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
      >
        <img
          src={src}
          alt={photo.fileName}
          className="max-w-full max-h-full select-none transition-transform duration-150"
          style={{
            transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
            objectFit: 'contain',
          }}
          draggable={false}
        />

        {/* Tag names on image (bottom-right) */}
        {currentTags.length > 0 && (
          <div className="absolute bottom-4 right-4 flex flex-wrap gap-1 justify-end max-w-[60%]">
            {currentTags.map(tag => (
              <span
                key={tag.id}
                className="px-2 py-0.5 rounded text-[11px] font-medium shadow-lg"
                style={{ backgroundColor: tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.8)'), color: '#fff' }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}

        {/* Navigation arrows */}
        {currentIndex > 0 && (
          <button
            onClick={() => goTo(currentIndex - 1)}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors"
          >
            <ChevronLeft size={24} />
          </button>
        )}
        {currentIndex < photos.length - 1 && (
          <button
            onClick={() => goTo(currentIndex + 1)}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors"
          >
            <ChevronRight size={24} />
          </button>
        )}
      </div>
    </div>
  )
}

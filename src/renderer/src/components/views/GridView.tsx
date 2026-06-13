import React, { useState, useEffect, useCallback, useRef } from 'react'
import { usePhotoStore } from '../../stores/photoStore'
import { useUIStore } from '../../stores/uiStore'
import { useEventStore } from '../../stores/eventStore'
import { cn } from '../../lib/cn'
import { X, ChevronLeft, ChevronRight, ImageIcon, RotateCcw, Trash2 } from 'lucide-react'

// Convert Windows path to photo:/// URL (forward slashes)
function toPhotoUrl(p: string): string {
  return `photo:///${p.replace(/\\/g, '/')}`
}

export function GridView(): React.JSX.Element {
  const { photos, selectedPhotoIds, selectPhoto, togglePhotoSelection, trashPhotos, removePhotos, setTrashPhotos, clearSelection } = usePhotoStore()
  const { thumbnailSize, showingTrash, setShowingTrash } = useUIStore()
  const { setSelectedEvent } = useEventStore()
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [photoTags, setPhotoTags] = useState<Record<string, { id: string; name: string; color: string }[]>>({})
  const [lastRestored, setLastRestored] = useState<string[] | null>(null)

  // Load tags for all displayed photos (also refresh when preview closes)
  useEffect(() => {
    const display = showingTrash ? trashPhotos : photos
    if (display.length === 0) return
    let cancelled = false
    const load = async (): Promise<void> => {
      const map: Record<string, { id: string; name: string; color: string }[]> = {}
      const batchSize = 20
      for (let i = 0; i < display.length; i += batchSize) {
        const batch = display.slice(i, i + batchSize)
        const results = await Promise.all(
          batch.map(p =>
            window.electron.ipcRenderer.invoke('tags:listForPhoto', p.id)
              .catch(() => []) as Promise<{ id: string; name: string; color: string }[]>
          )
        )
        if (cancelled) return
        batch.forEach((p, idx) => { if (results[idx].length > 0) map[p.id] = results[idx] })
      }
      if (!cancelled) setPhotoTags(map)
    }
    load()
    return () => { cancelled = true }
  }, [photos, trashPhotos, showingTrash, previewIndex === null ? 'closed' : 'open'])

  // Use trashPhotos when in trash view, normal photos otherwise
  const displayPhotos = showingTrash ? trashPhotos : photos

  const goTo = useCallback((index: number) => {
    setPreviewIndex(Math.max(0, Math.min(displayPhotos.length - 1, index)))
    selectPhoto(displayPhotos[Math.max(0, Math.min(displayPhotos.length - 1, index))].id)
  }, [displayPhotos, selectPhoto])

  useEffect(() => {
    if (previewIndex === null) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { setPreviewIndex(null); return }
      if (e.key === 'ArrowLeft') { goTo(previewIndex - 1); return }
      if (e.key === 'ArrowRight') { goTo(previewIndex + 1); return }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [previewIndex, goTo])

  const handleRestore = async (photoId: string): Promise<void> => {
    try {
      const result = await window.electron.ipcRenderer.invoke('photos:restore', [photoId]) as { success: boolean }
      if (result.success) removePhotos([photoId])
    } catch (err) {
      console.error('Failed to restore photo:', err)
    }
  }

  if (displayPhotos.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          {showingTrash ? (
            <>
              <div className="text-5xl mb-4">🗑️</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">回收站是空的</div>
            </>
          ) : (
            <>
              <div className="text-5xl mb-4">📸</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">暂无照片</div>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {showingTrash && (
        <div className="sticky top-0 z-20 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xs text-red-600 dark:text-red-400">
              回收站 ({displayPhotos.length} 张)
            </span>
            {selectedPhotoIds.size > 0 && (
              <>
                <span className="text-xs text-red-500">已选 {selectedPhotoIds.size} 张</span>
                <button
                  onClick={async () => {
                    const ids = Array.from(selectedPhotoIds)
                    try {
                      const result = await window.electron.ipcRenderer.invoke('photos:restore', ids) as { success: boolean }
                      if (result.success) {
                        setLastRestored(ids)
                        removePhotos(ids)
                        clearSelection()
                        setShowingTrash(false)
                        const evRow = await window.electron.ipcRenderer.invoke('photos:get', ids[0]) as { eventId: string } | null
                        if (evRow) setSelectedEvent(evRow.eventId)
                        window.dispatchEvent(new CustomEvent('refresh-events'))
                      }
                    } catch (err) {
                      console.error('Failed to batch restore:', err)
                    }
                  }}
                  className="px-2 py-1 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors flex items-center gap-1"
                >
                  <RotateCcw size={13} />
                  恢复选中
                </button>
              </>
            )}
          </div>
          <button
            onClick={async () => {
              const confirmed = window.confirm(`确定要永久清空回收站吗？\n\n${displayPhotos.length} 张照片文件和缩略图将被彻底删除，此操作不可撤销！`)
              if (!confirmed) return
              try {
                const result = await window.electron.ipcRenderer.invoke('photos:emptyTrash') as { success: boolean; deleted: number }
                if (result.success) {
                  setTrashPhotos([])
                  clearSelection()
                  window.dispatchEvent(new CustomEvent('refresh-events'))
                }
              } catch (err) {
                console.error('Failed to empty trash:', err)
              }
            }}
            className="px-2.5 py-1 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors flex items-center gap-1"
          >
            <Trash2 size={13} />
            清空回收站
          </button>
        </div>
      )}

      {/* Undo restore banner */}
      {!showingTrash && lastRestored && lastRestored.length > 0 && (
        <div className="sticky top-0 z-20 bg-orange-50 dark:bg-orange-900/20 border-b border-orange-200 dark:border-orange-800 px-4 py-2 flex items-center justify-center gap-3">
          <span className="text-xs text-orange-600 dark:text-orange-400">
            已恢复 {lastRestored.length} 张照片
          </span>
          <button
            onClick={async () => {
              const ids = [...lastRestored]
              setLastRestored(null)
              try {
                await window.electron.ipcRenderer.invoke('photos:delete', ids)
                setShowingTrash(true)
                window.dispatchEvent(new CustomEvent('refresh-events'))
              } catch {}
            }}
            className="px-2 py-1 text-xs font-medium bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors"
          >
            撤销
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-[3px] p-[3px] content-start">
        {displayPhotos.map((photo, index) => {
          const isSelected = selectedPhotoIds.has(photo.id)
          const src = (photo.thumbnailPath || photo.filePath) ? toPhotoUrl(photo.thumbnailPath || photo.filePath) : ''
          return (
            <div
              key={photo.id}
              className={cn(
                'relative group cursor-pointer overflow-hidden bg-gray-100 dark:bg-gray-800 shrink-0',
                isSelected ? 'ring-2 ring-[#007AFF] shadow-md z-10' : 'ring-1 ring-transparent hover:ring-gray-300'
              )}
              style={{ width: thumbnailSize, height: thumbnailSize }}
              onClick={() => selectPhoto(photo.id)}
              onDoubleClick={() => { selectPhoto(photo.id); setPreviewIndex(index) }}
              onContextMenu={(e) => { e.preventDefault(); togglePhotoSelection(photo.id) }}
            >
              {src ? (
                <img
                  src={src}
                  alt={photo.fileName}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  onError={(e) => {
                    // Replace broken image with fallback icon
                    const target = e.currentTarget
                    target.style.display = 'none'
                    const parent = target.parentElement
                    if (parent && !parent.querySelector('.img-fallback')) {
                      const fallback = document.createElement('div')
                      fallback.className = 'img-fallback w-full h-full flex items-center justify-center text-gray-400'
                      fallback.innerHTML = '📷'
                      parent.appendChild(fallback)
                    }
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400"><ImageIcon size={24} /></div>
              )}
              <div className="absolute top-1 left-1 flex gap-0.5">
                {photo.flag === 'pick' && <span className="text-[9px] font-bold text-green-300 bg-green-900/80 px-1 py-0.5 rounded">P</span>}
                {photo.flag === 'reject' && <span className="text-[9px] font-bold text-red-300 bg-red-900/80 px-1 py-0.5 rounded">X</span>}
                {photo.needsEdit && <span className="text-[9px] font-medium text-blue-300 bg-blue-900/80 px-1 py-0.5 rounded">修</span>}
              </div>

              {/* Tag names (bottom-left) */}
              {photoTags[photo.id] && photoTags[photo.id].length > 0 && (
                <div className="absolute bottom-1 left-1 flex flex-wrap gap-0.5 max-w-[60%]">
                  {photoTags[photo.id].slice(0, 3).map(tag => (
                    <span
                      key={tag.id}
                      className="text-[8px] font-medium text-white px-1 py-0.5 rounded truncate"
                      style={{ backgroundColor: tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.73)') }}
                      title={tag.name}
                    >
                      {tag.name}
                    </span>
                  ))}
                  {photoTags[photo.id].length > 3 && (
                    <span className="text-[8px] text-white bg-black/50 px-1 py-0.5 rounded">
                      +{photoTags[photo.id].length - 3}
                    </span>
                  )}
                </div>
              )}

              {/* Resolution badge on hover */}
              {(photo.width > 0 || photo.height > 0) && (
                <div className="absolute bottom-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-[9px] font-medium text-white bg-black/60 px-1.5 py-0.5 rounded">
                    {photo.width} × {photo.height}
                  </span>
                </div>
              )}

              {/* Restore button on hover (trash view only) */}
              {showingTrash && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRestore(photo.id) }}
                    className="p-1.5 bg-green-500 hover:bg-green-600 rounded-full text-white transition-colors"
                    title="恢复"
                  >
                    <RotateCcw size={16} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {previewIndex !== null && displayPhotos[previewIndex] && (
        <PhotoPreview
          photo={displayPhotos[previewIndex]}
          index={previewIndex}
          total={displayPhotos.length}
          onPrev={() => goTo(previewIndex - 1)}
          onNext={() => goTo(previewIndex + 1)}
          onClose={() => setPreviewIndex(null)}
          prevFilePath={previewIndex > 0 ? displayPhotos[previewIndex - 1]?.filePath : undefined}
          nextFilePath={previewIndex < displayPhotos.length - 1 ? displayPhotos[previewIndex + 1]?.filePath : undefined}
        />
      )}
    </div>
  )
}

function PhotoPreview({
  photo, index, total, onPrev, onNext, onClose, prevFilePath, nextFilePath,
}: {
  photo: { id: string; eventId: string; filePath: string; fileName: string; thumbnailPath?: string | null }
  index: number; total: number
  onPrev: () => void; onNext: () => void; onClose: () => void
  prevFilePath?: string; nextFilePath?: string
}): React.JSX.Element {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [fullLoaded, setFullLoaded] = useState(false)
  const [photoTags, setPhotoTags] = useState<{ id: string; name: string; color: string }[]>([])
  const [eventTags, setEventTags] = useState<{ id: string; name: string; color: string }[]>([])
  const [nickname, setNickname] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)

  // Load tags and settings
  useEffect(() => {
    window.electron.ipcRenderer.invoke('tags:listForPhoto', photo.id).then((r: unknown) => {
      setPhotoTags(r as { id: string; name: string; color: string }[])
    }).catch(() => {})
    window.electron.ipcRenderer.invoke('tags:list', photo.eventId).then((r: unknown) => {
      setEventTags(r as { id: string; name: string; color: string }[])
    }).catch(() => {})
    window.electron.ipcRenderer.invoke('settings:get').then((r: unknown) => {
      setNickname((r as any).nickname || '')
    }).catch(() => {})
  }, [photo.id, photo.eventId])

  // Force focus onto the overlay so keyboard events are captured
  useEffect(() => {
    overlayRef.current?.focus()
  }, [photo.id])

  const thumbSrc = photo.thumbnailPath ? toPhotoUrl(photo.thumbnailPath) : null
  const fullSrc = photo.filePath ? toPhotoUrl(photo.filePath) : ''

  // Use refs to avoid stale closures in the window event listener
  const eventTagsRef = useRef(eventTags)
  const photoTagsRef = useRef(photoTags)
  const nicknameRef = useRef(nickname)
  const onCloseRef = useRef(onClose)
  const onPrevRef = useRef(onPrev)
  const onNextRef = useRef(onNext)
  eventTagsRef.current = eventTags
  photoTagsRef.current = photoTags
  nicknameRef.current = nickname
  onCloseRef.current = onClose
  onPrevRef.current = onPrev
  onNextRef.current = onNext

  const handleKeyEvent = useCallback((e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current(); return }
    if (e.key === ' ' || e.key === 'Space') {
      e.preventDefault()
      e.stopPropagation()
      const tags = eventTagsRef.current
      const curTags = photoTagsRef.current
      const nick = nicknameRef.current
      const evId = photo.eventId
      const phId = photo.id

      // Determine tag name: nickname from settings, or "默认" as fallback
      const tagName = nick || '默认'
      const nicknameTag = tags.find(t => t.name === tagName)

      if (!nicknameTag) {
        // Auto-create the nickname tag (first time or nickname changed)
        window.electron.ipcRenderer.invoke('tags:create', { eventId: evId, name: tagName })
          .then((created: unknown) => {
            const newTag = created as { id: string; name: string; color: string; error?: string }
            if (newTag.error) { return }
            // Add tag to photo immediately
            window.electron.ipcRenderer.invoke('tags:addToPhoto', {
              photoId: phId, tagId: newTag.id, eventId: evId,
            }).then(() => {
              setPhotoTags(prev => [...prev, { id: newTag.id, name: newTag.name, color: newTag.color }])
              setEventTags(prev => [...prev, { id: newTag.id, name: newTag.name, color: newTag.color }])
              window.dispatchEvent(new Event('refresh-tags'))
            }).catch(() => {})
          }).catch(() => {})
        return
      }

      // Toggle the nickname tag on/off the photo
      window.electron.ipcRenderer.invoke('tags:toggleOnPhoto', {
        photoId: phId, tagId: nicknameTag.id, eventId: evId,
      }).then((res: unknown) => {
        const hasTag = (res as { hasTag: boolean }).hasTag
        setPhotoTags(hasTag
          ? [...curTags, nicknameTag]
          : curTags.filter(t => t.id !== nicknameTag.id)
        )
        window.dispatchEvent(new Event('refresh-tags'))
      }).catch(() => {})
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'h') { e.preventDefault(); e.stopPropagation(); onPrevRef.current?.(); return }
    if (e.key === 'ArrowRight' || e.key === 'l') { e.preventDefault(); e.stopPropagation(); onNextRef.current?.(); return }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); e.stopPropagation(); onPrevRef.current?.(); return }
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); e.stopPropagation(); onNextRef.current?.(); return }
  }, [photo.id, photo.eventId])

  // Listen on window (capture phase to intercept before other handlers)
  useEffect(() => {
    window.addEventListener('keydown', handleKeyEvent, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyEvent, { capture: true })
  }, [handleKeyEvent])

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 bg-black/90 flex flex-col overflow-hidden"
      tabIndex={-1}
      onDoubleClick={() => { setZoom(z => z === 1 ? 2 : 1); setPan({x:0,y:0}) }}
      onWheel={(e) => { e.preventDefault(); setZoom(z => Math.max(0.25, Math.min(5, z + (e.deltaY > 0 ? -0.25 : 0.25)))) }}
      onMouseDown={(e) => { if (zoom > 1) { setDragging(true); setDragStart({x:e.clientX-pan.x, y:e.clientY-pan.y}) } }}
      onMouseMove={(e) => { if (dragging) setPan({x:e.clientX-dragStart.x, y:e.clientY-dragStart.y}) }}
      onMouseUp={() => setDragging(false)}
      onMouseLeave={() => setDragging(false)}
      style={{ cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
    >
      <div className="h-11 flex items-center justify-between px-4 bg-black/50 text-white/80 shrink-0 z-10">
        <div className="flex items-center gap-3 text-sm">
          <button onClick={onClose} className="flex items-center gap-1 hover:text-white"><X size={18} />关闭</button>
          <span className="text-white/70">{photo.fileName}</span>
          {/* Tags in toolbar */}
          {photoTags.map(tag => (
            <span key={tag.id} className="px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{ backgroundColor: tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.19)'), color: tag.color }}>
              {tag.name}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-white/50">{index + 1} / {total}</span>
          {nickname && eventTags.length > 0 && (
            <span className="text-white/40 text-[10px]">空格键打标签</span>
          )}
          <button onClick={() => { setZoom(z => z === 1 ? 2 : 1); setPan({x:0,y:0}) }} className="hover:text-white">{zoom === 1 ? '200%' : '100%'}</button>
          <span className="text-white/50">{Math.round(zoom * 100)}%</span>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center relative overflow-hidden">
        {thumbSrc && <img src={thumbSrc} alt="" className="absolute inset-0 w-full h-full object-contain" style={{ opacity: fullLoaded ? 0 : 1, transition: 'opacity 0.3s' }} draggable={false} />}
        {fullSrc && <img src={fullSrc} alt={photo.fileName} className="max-w-full max-h-full" style={{ transform: `scale(${zoom}) translate(${pan.x/zoom}px, ${pan.y/zoom}px)`, opacity: fullLoaded ? 1 : 0, transition: 'opacity 0.3s' }} draggable={false} onLoad={() => setFullLoaded(true)} />}

        {/* Tag names on image (bottom-right) */}
        {photoTags.length > 0 && (
          <div className="absolute bottom-4 right-4 flex flex-wrap gap-1 justify-end max-w-[60%]">
            {photoTags.map(tag => (
              <span key={tag.id} className="px-2 py-0.5 rounded text-[11px] font-medium shadow-lg text-white"
                style={{ backgroundColor: tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.8)') }}>
                {tag.name}
              </span>
            ))}
          </div>
        )}

        {index > 0 && <button onClick={(e) => { e.stopPropagation(); onPrev() }} className="absolute left-4 top-1/2 -translate-y-1/2 p-2 bg-black/40 hover:bg-black/70 rounded-full text-white"><ChevronLeft size={28} /></button>}
        {index < total - 1 && <button onClick={(e) => { e.stopPropagation(); onNext() }} className="absolute right-4 top-1/2 -translate-y-1/2 p-2 bg-black/40 hover:bg-black/70 rounded-full text-white"><ChevronRight size={28} /></button>}
        {prevFilePath && <img src={toPhotoUrl(prevFilePath)} className="hidden" alt="" />}
        {nextFilePath && <img src={toPhotoUrl(nextFilePath)} className="hidden" alt="" />}
      </div>
    </div>
  )
}

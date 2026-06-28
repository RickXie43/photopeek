import React, { useState, useEffect, useCallback } from 'react'
import { usePhotoStore } from '../../stores/photoStore'
import { useUIStore } from '../../stores/uiStore'
import { useEventStore } from '../../stores/eventStore'
import { cn } from '../../lib/cn'
import { ImageIcon, RotateCcw, Trash2 } from 'lucide-react'
import { LoupeView } from './LoupeView'
import { PhotoThumbnail } from '../photo/PhotoThumbnail'

// Convert Windows path to photo:/// URL (forward slashes)
function toPhotoUrl(p: string): string {
  return `photo:///${p.replace(/\\/g, '/')}`
}

/** Generate a consistent color from a username string */
function userColor(username: string): string {
  let hash = 0
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 55%, 45%)`
}

/** Abbreviate version name for badge display */
function abbreviateVersion(v: string): { label: string; cls: string } {
  // Direct format names (new style) or prefixed (old style for compatibility)
  const raw = ['RAW', 'DNG', '原始RAW', '原始DNG']
  if (raw.includes(v)) return { label: v.startsWith('原始') ? v.slice(2) : v, cls: 'bg-yellow-500/80 text-black' }
  if (v === 'JPEG' || v === '相机JPEG') return { label: 'JPEG', cls: 'bg-blue-500/80 text-white' }
  if (v === 'PNG' || v === '相机PNG') return { label: 'PNG', cls: 'bg-blue-500/80 text-white' }
  if (v === 'HEIC' || v === '相机HEIC') return { label: 'HEIC', cls: 'bg-blue-500/80 text-white' }
  if (v === 'TIFF' || v === '原始TIFF') return { label: 'TIFF', cls: 'bg-cyan-600/80 text-white' }
  if (v === 'AVIF' || v === '相机AVIF') return { label: 'AVIF', cls: 'bg-blue-500/80 text-white' }
  // User uploads / edits (format: username_number)
  if (v.includes('修图') || v.includes('上传') || v.includes('手机')) return { label: '修', cls: 'bg-green-500/80 text-white' }
  return { label: v.replace(/_/g, ' · '), cls: '' }
}

// Standard format abbreviation names for grouping
const FORMAT_BADGES = new Set(['RAW', 'DNG', 'JPEG', 'PNG', 'HEIC', 'TIFF', 'AVIF', '修'])

/** Parse versionSummary JSON and return badges grouped: { formats: [...], users: [...] } */
function getVersionBadges(photo: { versionSummary?: string | null }): { formats: { label: string; cls: string }[]; users: { label: string; cls: string; color: string }[] } {
  const result = { formats: [] as { label: string; cls: string }[], users: [] as { label: string; cls: string; color: string }[] }
  if (!photo.versionSummary) return result
  try {
    const names: string[] = JSON.parse(photo.versionSummary)
    const seenFormats = new Set<string>()
    const seenUsers = new Set<string>()
    for (const n of names) {
      const b = abbreviateVersion(n)
      if (FORMAT_BADGES.has(b.label)) {
        if (!seenFormats.has(b.label)) {
          seenFormats.add(b.label)
          result.formats.push(b)
        }
      } else {
        if (!seenUsers.has(b.label)) {
          seenUsers.add(b.label)
          // Extract username for color
          const userName = n.includes('_') ? n.split('_')[0] : n.slice(0, 6)
          result.users.push({ ...b, color: userColor(userName) })
        }
      }
    }
    return result
  } catch {
    return result
  }
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
                <PhotoThumbnail src={src} alt={photo.fileName} />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400"><ImageIcon size={24} /></div>
              )}
              <div className="absolute top-1 left-1 flex flex-col gap-0.5" style={{ fontSize: Math.max(8, thumbnailSize / 18) + 'px' }}>
                {/* Version badges: original formats row */}
                {(() => {
                  const badges = getVersionBadges(photo)
                  return (
                    <>
                      {badges.formats.length > 0 && (
                        <div className="flex gap-0.5 flex-wrap">
                          {badges.formats.map((b, i) => (
                            <span key={i} className={`font-medium px-0.5 py-0.5 rounded min-w-[3ch] text-center ${b.cls}`}>{b.label}</span>
                          ))}
                        </div>
                      )}
                      {/* Version badges: user uploads row */}
                      {badges.users.length > 0 && (
                        <div className="flex gap-0.5 flex-wrap">
                          {badges.users.map((b, i) => (
                            <span key={i} className="font-medium px-0.5 py-0.5 rounded min-w-[3ch] text-center text-white" style={{ backgroundColor: b.color }}>{b.label}</span>
                          ))}
                        </div>
                      )}
                    </>
                  )
                })()}
                {/* Flag badges */}
                {photo.flag === 'pick' && <span className="font-medium text-green-300 bg-green-900/80 px-0.5 py-0.5 rounded">P</span>}
                {photo.flag === 'reject' && <span className="font-medium text-red-300 bg-red-900/80 px-0.5 py-0.5 rounded">X</span>}
                {photo.needsEdit && <span className="font-medium text-blue-300 bg-blue-900/80 px-0.5 py-0.5 rounded">修</span>}
              </div>

              {/* Tag names (bottom-left) */}
              {photoTags[photo.id] && photoTags[photo.id].length > 0 && (
                <div className="absolute bottom-1 left-1 flex flex-wrap gap-0.5 max-w-[60%]" style={{ fontSize: Math.max(8, thumbnailSize / 18) + 'px' }}>
                  {photoTags[photo.id].slice(0, 3).map(tag => (
                    <span
                      key={tag.id}
                      className="font-medium text-white px-1 py-0.5 rounded truncate"
                      style={{ backgroundColor: tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.73)') }}
                      title={tag.name}
                    >
                      {tag.name}
                    </span>
                  ))}
                  {photoTags[photo.id].length > 3 && (
                    <span className="text-white bg-black/50 px-1 py-0.5 rounded">
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
        <div className="fixed inset-0 z-50 flex flex-col" data-loupe="true">
          <LoupeView onClose={() => setPreviewIndex(null)} />
        </div>
      )}
    </div>
  )
}



import React, { useState, useEffect, useCallback, useRef } from 'react'
import { usePhotoStore } from '../../stores/photoStore'
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Tag,
  Layers,
  Trash2,
  Upload
} from 'lucide-react'
import type { PhotoVersion, Tag as PhotoTagDefinition } from '../../types/photo'
import { cn } from '../../lib/cn'

/** Format file size */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

/** Check if a file is a RAW format (cannot be previewed in browser) */
function isRawFile(fileName: string): boolean {
  const ext = (fileName || '').toLowerCase().split('.').pop()
  return ['cr2', 'cr3', 'nef', 'arw', 'rw2', 'orf', 'raf', 'dng', 'raw', 'srf', 'sr2'].includes(
    ext || ''
  )
}

interface ComparedVersion {
  version: PhotoVersion
  url: string
}

type DisplayTag = Pick<PhotoTagDefinition, 'id' | 'name' | 'color'>

interface TagState {
  photoTags: DisplayTag[]
  eventTags: DisplayTag[]
  warning?: string
}

export function LoupeView({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { photos, selectedPhotoIds, selectPhoto } = usePhotoStore()
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [photoTags, setPhotoTags] = useState<Record<string, DisplayTag[]>>({})
  const [eventTags, setEventTags] = useState<DisplayTag[]>([])
  const [tagError, setTagError] = useState('')
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const tagQueueRef = useRef<Promise<void>>(Promise.resolve())
  const tagMutationRevisionRef = useRef(0)
  const pendingTagMutationsRef = useRef(0)
  const tagLoadRequestRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // ── Version state ──────────────────────────────────────────────────────
  const [versions, setVersions] = useState<PhotoVersion[]>([])
  const [selectedVersionIds, setSelectedVersionIds] = useState<Set<string>>(new Set())
  const [compareMode, setCompareMode] = useState<'single' | 'side-by-side' | 'toggle' | 'slide'>(
    'single'
  )
  const [toggleIndex, setToggleIndex] = useState(0)
  const [versionPanelOpen, setVersionPanelOpen] = useState(true)
  const [previewFallback, setPreviewFallback] = useState<string | null>(null)

  const toPhotoUrl = (p: string): string => `photo:///${p.replace(/\\/g, '/')}`

  const selectedId = Array.from(selectedPhotoIds)[0]
  // Search in both photos and trashPhotos to find the selected photo
  const allPhotos = [...photos, ...(usePhotoStore.getState().trashPhotos || [])]
  const currentIndex = allPhotos.findIndex((p) => p.id === selectedId)
  const photo = currentIndex >= 0 ? allPhotos[currentIndex] : null

  // Load versions when photo changes
  useEffect(() => {
    if (!photo) {
      setVersions([])
      return
    }
    setPreviewFallback(null)
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        let result = (await window.electron.ipcRenderer.invoke(
          'photos:listVersions',
          photo.id
        )) as PhotoVersion[]
        // If no versions found, try migrating first (handles old photos)
        if (result.length === 0) {
          console.log('[LoupeView] No versions found, triggering migration for', photo.fileName)
          await window.electron.ipcRenderer.invoke('photos:migrateVersions', photo.eventId)
          result = (await window.electron.ipcRenderer.invoke(
            'photos:listVersions',
            photo.id
          )) as PhotoVersion[]
        }
        if (cancelled) return
        console.log('[LoupeView] Loaded', result.length, 'versions for', photo.fileName)
        setVersions(result)
        // Default: select the first non-RAW version (usually JPEG)
        const firstSelectable = result.find((v) => !isRawFile(v.fileName))
        if (firstSelectable) setSelectedVersionIds(new Set([firstSelectable.id]))
        else if (result.length > 0) setSelectedVersionIds(new Set([result[0].id]))
      } catch (err) {
        console.error('[LoupeView] Failed to load versions:', err)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [photo?.id])

  // Load tags for the current photo and event
  useEffect(() => {
    if (!photo) {
      setEventTags([])
      return
    }
    let cancelled = false
    const loadTags = async (): Promise<void> => {
      const request = ++tagLoadRequestRef.current
      const revision = tagMutationRevisionRef.current
      try {
        const [ptags, etags] = await Promise.all([
          window.electron.ipcRenderer.invoke('tags:listForPhoto', photo.id) as Promise<DisplayTag[]>,
          window.electron.ipcRenderer.invoke('tags:list', photo.eventId) as Promise<DisplayTag[]>
        ])
        // A read started before a mutation (or for an old selection) must not
        // overwrite the authoritative state returned by that mutation.
        if (
          cancelled || request !== tagLoadRequestRef.current ||
          revision !== tagMutationRevisionRef.current || pendingTagMutationsRef.current > 0
        ) return
        setPhotoTags((prev) => ({ ...prev, [photo.id]: ptags }))
        setEventTags(etags)
      } catch (error) {
        if (!cancelled && request === tagLoadRequestRef.current && mountedRef.current) {
          setTagError(error instanceof Error ? error.message : '读取标签失败，请重试')
        }
      }
    }
    loadTags()
    window.addEventListener('refresh-tags', loadTags)
    return () => {
      cancelled = true
      window.removeEventListener('refresh-tags', loadTags)
    }
  }, [photo?.id, photo?.eventId])

  const currentTags = photo ? photoTags[photo.id] || [] : []
  const [nickname, setNickname] = useState('')

  // Settings can change while the same loupe stays open.
  useEffect(() => {
    let cancelled = false
    let settingsRevision = 0
    const loadNickname = async (): Promise<void> => {
      const revision = ++settingsRevision
      try {
        const settings = (await window.electron.ipcRenderer.invoke('settings:get')) as {
          nickname?: string
        }
        if (!cancelled && revision === settingsRevision) {
          const nextNickname = (settings.nickname || '').trim()
          nicknameRef.current = nextNickname
          setNickname(nextNickname)
        }
      } catch (error) {
        if (!cancelled) setTagError(error instanceof Error ? error.message : '读取昵称失败，请重试')
      }
    }
    const handleSettingsChanged = (event: Event): void => {
      const settings = (event as CustomEvent<{ nickname?: string }>).detail
      if (settings && typeof settings.nickname === 'string') {
        settingsRevision++
        const nextNickname = settings.nickname.trim()
        nicknameRef.current = nextNickname
        setNickname(nextNickname)
      } else {
        void loadNickname()
      }
    }
    void loadNickname()
    window.addEventListener('settings-changed', handleSettingsChanged)
    return () => {
      cancelled = true
      window.removeEventListener('settings-changed', handleSettingsChanged)
    }
  }, [])

  // Keep a ref to current photo ID for the async toggle function
  const photoIdRef = useRef(photo?.id)
  const eventIdRef = useRef(photo?.eventId)
  photoIdRef.current = photo?.id
  eventIdRef.current = photo?.eventId

  // Preserve every real key press, including its photo and nickname at the
  // time of the press. Serialize writes so rapid presses cannot race.
  const queueTagMutation = useCallback((
    pid: string,
    eid: string,
    mutate: () => Promise<TagState>
  ): Promise<void> => {
    pendingTagMutationsRef.current++
    tagMutationRevisionRef.current++
    const run = async (): Promise<void> => {
      if (mountedRef.current) setTagError('')
      try {
        const result = await mutate()
        tagMutationRevisionRef.current++
        if (mountedRef.current) {
          setPhotoTags((prev) => ({ ...prev, [pid]: result.photoTags }))
          if (eventIdRef.current === eid) setEventTags(result.eventTags)
          setTagError(result.warning || '')
        }
      } catch (error) {
        console.error('[LoupeView] Failed to update tags:', error)
        if (mountedRef.current) {
          setTagError(error instanceof Error ? error.message : '修改标签失败，请重试')
        }
      } finally {
        pendingTagMutationsRef.current--
        window.dispatchEvent(new Event('refresh-tags'))
      }
    }
    tagQueueRef.current = tagQueueRef.current.then(run, run)
    return tagQueueRef.current
  }, [])

  const toggleNicknameTag = useCallback((): Promise<void> => {
    const pid = photoIdRef.current
    const eid = eventIdRef.current
    const nick = nicknameRef.current.trim()
    if (!pid || !eid || !nick) return Promise.resolve()
    return queueTagMutation(pid, eid, () => window.electron.ipcRenderer.invoke(
      'tags:toggleNicknameOnPhoto', { photoId: pid, eventId: eid, nickname: nick }
    ) as Promise<TagState>)
  }, [queueTagMutation])

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

  // Keyboard navigation + tag toggle (uses refs to avoid detach/reattach loops)
  const onCloseRef = useRef(onClose)
  const currentIndexRef = useRef(currentIndex)
  const toggleNicknameTagRef = useRef(toggleNicknameTag)
  const goToRef = useRef(goTo)
  const nicknameRef = useRef(nickname)
  const versionsRef = useRef(versions)
  onCloseRef.current = onClose
  currentIndexRef.current = currentIndex
  toggleNicknameTagRef.current = toggleNicknameTag
  goToRef.current = goTo
  nicknameRef.current = nickname
  versionsRef.current = versions

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const target = e.target instanceof HTMLElement ? e.target : null
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const isEditable = (element: HTMLElement | null): boolean => !!element && (
        !!element.closest('input, textarea, select') || element.isContentEditable
      )
      if (
        isEditable(target) || isEditable(active) || e.isComposing ||
        e.ctrlKey || e.metaKey || e.altKey ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      ) return

      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'h' || e.key === 'H') {
        goToRef.current(currentIndexRef.current - 1)
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'l' || e.key === 'L') {
        goToRef.current(currentIndexRef.current + 1)
        return
      }
      // j/k: switch versions in single-select mode
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        const vers = versionsRef.current
        if (vers.length > 0) {
          setSelectedVersionIds((prev) => {
            const sorted = vers.filter((v) => !isRawFile(v.fileName))
            if (sorted.length === 0) sorted.push(...vers)
            const current = Array.from(prev).find((id) => prev.has(id))
            const idx = current ? sorted.findIndex((v) => v.id === current) : -1
            const next = sorted[(idx + 1) % sorted.length]
            return new Set([next.id])
          })
        }
        return
      }
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        const vers = versionsRef.current
        if (vers.length > 0) {
          setSelectedVersionIds((prev) => {
            const sorted = vers.filter((v) => !isRawFile(v.fileName))
            if (sorted.length === 0) sorted.push(...vers)
            const current = Array.from(prev).find((id) => prev.has(id))
            const idx = current ? sorted.findIndex((v) => v.id === current) : 0
            const next = sorted[(idx - 1 + sorted.length) % sorted.length]
            return new Set([next.id])
          })
        }
        return
      }
      if (e.key === ' ' || e.code === 'Space') {
        if (e.defaultPrevented) return
        e.preventDefault()
        if (e.repeat) return
        if (nicknameRef.current) {
          toggleNicknameTagRef.current()
        } else {
          setZoom((z) => (z === 1 ? 2 : 1))
          setPan({ x: 0, y: 0 })
        }
        return
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        setTagMenuOpen((v) => !v)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, []) // empty deps — handler attached once, refs keep values fresh

  if (!photo) {
    return (
      <div className="flex-1 flex items-center justify-center bg-black/5">
        <div className="text-gray-400 text-sm">未选择照片</div>
      </div>
    )
  }

  const handleWheel = (e: React.WheelEvent): void => {
    if (selectedVersionIds.size !== 1) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.25 : 0.25
    setZoom((z) => Math.max(0.25, Math.min(5, z + delta)))
  }

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (selectedVersionIds.size !== 1) return
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
    if (selectedVersionIds.size !== 1) return
    setZoom((z) => (z === 1 ? 2 : 1))
    setPan({ x: 0, y: 0 })
  }

  // ── Version helpers ────────────────────────────────────────────────────
  const selectedVersions = versions.filter((v) => selectedVersionIds.has(v.id))

  const toggleVersion = (versionId: string): void => {
    const v = versions.find((v) => v.id === versionId)
    if (v && isRawFile(v.fileName)) return // RAW versions cannot be toggled for preview
    setSelectedVersionIds((prev) => {
      const next = new Set(prev)
      if (next.has(versionId)) {
        next.delete(versionId)
        // Always keep at least one selectable
        if (next.size === 0) {
          const firstSelectable = versions.find((v) => !isRawFile(v.fileName))
          if (firstSelectable) next.add(firstSelectable.id)
          else if (versions.length > 0) next.add(versions[0].id)
        }
      } else {
        next.add(versionId)
        // Auto-enter compare mode
        if (next.size >= 2) setCompareMode('side-by-side')
      }
      return next
    })
  }

  // When selection goes down to 1, exit compare mode
  useEffect(() => {
    if (selectedVersionIds.size <= 1 && compareMode !== 'single') {
      setCompareMode('single')
      setZoom(1)
      setPan({ x: 0, y: 0 })
    }
  }, [selectedVersionIds.size, compareMode])

  const handleImportVersion = async (): Promise<void> => {
    // Use Electron file dialog
    const result = (await window.electron.ipcRenderer.invoke('import:selectFiles')) as
      | string[]
      | null
    if (!result || result.length === 0) return
    const filePath = result[0]
    const fileName = filePath.split(/[\\/]/).pop() || 'photo'

    // Get nickname from settings for auto-generating version name
    let nickname = 'User'
    try {
      const settings = (await window.electron.ipcRenderer.invoke('settings:get')) as {
        nickname?: string
      }
      if (settings?.nickname) nickname = settings.nickname
    } catch {}
    // Count this user's existing non-original, non-RAW versions for auto-numbering
    const myVersions = versions.filter(
      (v) => !v.isOriginal && !isRawFile(v.fileName || '') && v.uploadedBy === nickname
    )
    const nextNum = myVersions.length + 1
    const versionName = nickname + '_' + nextNum

    try {
      const stats = (await window.electron.ipcRenderer.invoke('fs:stat', filePath)) as {
        size: number
      } | null
      const verResult = (await window.electron.ipcRenderer.invoke('photos:addVersion', {
        photoId: photo.id,
        versionName,
        filePath,
        fileName,
        fileSize: stats?.size || 0,
        width: 0,
        height: 0,
        metadata: null,
        uploadedBy: nickname
      })) as { success: boolean; error?: string }
      if (verResult.success) {
        const result = (await window.electron.ipcRenderer.invoke(
          'photos:listVersions',
          photo.id
        )) as PhotoVersion[]
        setVersions(result)
        // Refresh grid view to update version badges
        window.dispatchEvent(new Event('refresh-photos'))
      } else {
        console.error('Failed to add version:', verResult.error)
      }
    } catch (err) {
      console.error('Failed to import version:', err)
    }
  }

  const handleDeleteVersion = async (): Promise<void> => {
    const toDelete = selectedVersions.filter((v) => !v.isOriginal)
    if (toDelete.length === 0) return
    const msg = `确定要删除选中的 ${toDelete.length} 个版本吗？\n文件将被永久删除。`
    if (!window.confirm(msg)) return

    for (const v of toDelete) {
      try {
        await window.electron.ipcRenderer.invoke('photos:deleteVersion', v.id)
      } catch {}
    }
    const result = (await window.electron.ipcRenderer.invoke(
      'photos:listVersions',
      photo.id
    )) as PhotoVersion[]
    setVersions(result)
    window.dispatchEvent(new Event('refresh-tags'))
  }

  // ── Compare: build URLs for selected versions ──────────────────────────
  const compareItems: ComparedVersion[] = selectedVersions.map((v) => ({
    version: v,
    url: toPhotoUrl(v.filePath)
  }))

  return (
    <div className="flex-1 flex bg-[#1a1a1a] min-h-0">
      {/* Left: Toolbar + Image */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Loupe toolbar */}
        <div className="h-10 flex items-center justify-between px-4 bg-black/40 text-gray-300 shrink-0">
          <div className="flex items-center gap-3 text-xs min-w-0">
            <button
              onClick={onClose}
              className="hover:text-white transition-colors flex items-center gap-1 shrink-0"
            >
              <X size={16} /> 关闭
            </button>
            <span className="truncate">{photo.fileName}</span>
            {currentTags.map((tag) => (
              <span
                key={tag.id}
                className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                style={{
                  backgroundColor: tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.19)'),
                  color: tag.color
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs shrink-0">
            {selectedVersionIds.size >= 2 && (
              <>
                <button
                  onClick={() => setCompareMode('side-by-side')}
                  className={cn(
                    'px-1.5 py-0.5 rounded transition-colors',
                    compareMode === 'side-by-side'
                      ? 'bg-white/20 text-white'
                      : 'text-gray-400 hover:text-white'
                  )}
                >
                  并排
                </button>
                <button
                  onClick={() => setCompareMode('toggle')}
                  className={cn(
                    'px-1.5 py-0.5 rounded transition-colors',
                    compareMode === 'toggle'
                      ? 'bg-white/20 text-white'
                      : 'text-gray-400 hover:text-white'
                  )}
                >
                  切换
                </button>
                <button
                  onClick={() => selectedVersionIds.size === 2 && setCompareMode('slide')}
                  className={cn(
                    'px-1.5 py-0.5 rounded transition-colors',
                    compareMode === 'slide'
                      ? 'bg-white/20 text-white'
                      : 'text-gray-400 hover:text-white',
                    selectedVersionIds.size !== 2 && 'opacity-40 cursor-not-allowed'
                  )}
                  title={selectedVersionIds.size !== 2 ? '仅在选择两个版本时可用' : ''}
                >
                  滑动
                </button>
                <span className="text-gray-600">|</span>
              </>
            )}
            <span className="text-gray-500">
              {currentIndex + 1} / {photos.length}
            </span>
            <button
              onClick={() => setTagMenuOpen((v) => !v)}
              className="hover:text-white transition-colors flex items-center gap-1"
              title="标签 (T)"
            >
              <Tag size={14} />
              <span className="text-gray-400">{currentTags.length}</span>
            </button>
            {selectedVersionIds.size === 1 && (
              <button
                onClick={toggleZoom}
                className="hover:text-white transition-colors"
                title="切换放大"
              >
                {zoom === 1 ? <ZoomIn size={16} /> : <ZoomOut size={16} />}
              </button>
            )}
            {selectedVersionIds.size === 1 && (
              <span className="text-gray-500">{Math.round(zoom * 100)}%</span>
            )}
            <button
              onClick={() => setVersionPanelOpen((prev) => !prev)}
              className={cn(
                'p-1 rounded transition-colors',
                versionPanelOpen ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-white'
              )}
              title={versionPanelOpen ? '收起版本' : '展开版本'}
            >
              <Layers size={14} />
            </button>
          </div>
        </div>

        {tagError && (
          <div role="alert" className="px-4 py-2 bg-red-950/80 text-red-200 text-xs shrink-0">
            {tagError}
          </div>
        )}

        {/* Tag menu dropdown */}
        {tagMenuOpen && (
          <div className="absolute top-10 right-4 z-50 bg-[#2a2a2a] border border-gray-600 rounded-lg shadow-xl p-2 min-w-[160px]">
            <div className="text-[10px] text-gray-400 px-2 pb-1">选择标签</div>
            {eventTags.length === 0 ? (
              <div className="text-xs text-gray-500 px-2 py-1">暂无标签</div>
            ) : (
              eventTags.map((tag) => {
                const hasTag = currentTags.some((t) => t.id === tag.id)
                return (
                  <button
                    key={tag.id}
                    onClick={() => {
                      const pid = photo.id
                      const eid = photo.eventId
                      void queueTagMutation(pid, eid, async () => {
                        await window.electron.ipcRenderer.invoke('tags:toggleOnPhoto', {
                          photoId: pid, tagId: tag.id, eventId: eid
                        })
                        const [ptags, etags] = await Promise.all([
                          window.electron.ipcRenderer.invoke('tags:listForPhoto', pid),
                          window.electron.ipcRenderer.invoke('tags:list', eid)
                        ])
                        return { photoTags: ptags as DisplayTag[], eventTags: etags as DisplayTag[] }
                      })
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

        {/* Image / Compare area */}
        {selectedVersionIds.size <= 1 ? (
          /* Single image */
          <div
            className="flex-1 flex items-center justify-center overflow-hidden relative min-h-0"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDoubleClick={toggleZoom}
            style={{ cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
          >
            {selectedVersions[0] && (
              <img
                src={previewFallback || toPhotoUrl(selectedVersions[0].filePath)}
                alt={selectedVersions[0].fileName}
                className="max-w-full max-h-full select-none transition-transform duration-150"
                style={{
                  transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
                  objectFit: 'contain'
                }}
                draggable={false}
                onError={async () => {
                  const filePath = selectedVersions[0]?.filePath
                  if (!filePath || previewFallback) return
                  const preview = (await window.electron.ipcRenderer.invoke(
                    'image:readPreview',
                    filePath
                  )) as string | null
                  if (preview) setPreviewFallback(preview)
                }}
              />
            )}

            {/* Version info overlay */}
            {selectedVersions[0] && (
              <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] px-2 py-1 rounded">
                {selectedVersions[0].versionName}
                {selectedVersions[0].isOriginal && (
                  <span className="ml-1 text-yellow-400">★原始</span>
                )}
                {selectedVersions[0].uploadedBy && (
                  <span className="ml-1 text-gray-400">by {selectedVersions[0].uploadedBy}</span>
                )}
                <span className="ml-2 text-gray-400">
                  {selectedVersions[0].width}×{selectedVersions[0].height}
                </span>
              </div>
            )}

            {/* Tag names on image */}
            {currentTags.length > 0 && (
              <div className="absolute bottom-4 right-4 flex flex-wrap gap-1 justify-end max-w-[60%]">
                {currentTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="px-2 py-0.5 rounded text-[11px] font-medium shadow-lg"
                    style={{
                      backgroundColor: tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.8)'),
                      color: '#fff'
                    }}
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
        ) : (
          /* Compare mode */
          <div className="flex-1 flex overflow-hidden min-h-0 relative">
            {compareMode === 'side-by-side' && (
              <div className="flex-1 flex gap-px">
                {compareItems.map((item) => (
                  <div
                    key={item.version.id}
                    className="flex-1 flex flex-col items-center justify-center overflow-hidden bg-black/20 relative"
                  >
                    <div className="absolute top-1 left-1 z-10">
                      <span className="text-[10px] text-white bg-black/60 px-1.5 py-0.5 rounded">
                        {item.version.versionName}
                        {' · '}
                        {item.version.width}×{item.version.height}
                      </span>
                    </div>
                    <img
                      src={item.url}
                      alt={item.version.fileName}
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                ))}
              </div>
            )}
            {compareMode === 'toggle' && compareItems.length >= 2 && (
              <div className="flex-1 flex flex-col items-center justify-center overflow-hidden relative">
                <img
                  src={compareItems[toggleIndex].url}
                  alt=""
                  className="max-w-full max-h-full object-contain"
                />
                <div className="absolute bottom-4 left-4 right-4 flex items-center justify-center gap-3">
                  {compareItems.map((item, idx) => (
                    <button
                      key={item.version.id}
                      onClick={() => setToggleIndex(idx)}
                      className={cn(
                        'px-3 py-1 text-[11px] rounded transition-colors',
                        toggleIndex === idx
                          ? 'bg-[#007AFF] text-white'
                          : 'bg-black/50 text-gray-300 hover:bg-black/70'
                      )}
                    >
                      {item.version.versionName}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {compareMode === 'slide' && compareItems.length === 2 && (
              <SlideCompare primary={compareItems[0]} secondary={compareItems[1]} />
            )}
            {/* Navigation arrows in compare mode */}
            {currentIndex > 0 && (
              <button
                onClick={() => goTo(currentIndex - 1)}
                className="absolute left-4 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors z-10"
              >
                <ChevronLeft size={24} />
              </button>
            )}
            {currentIndex < photos.length - 1 && (
              <button
                onClick={() => goTo(currentIndex + 1)}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors z-10"
              >
                <ChevronRight size={24} />
              </button>
            )}
          </div>
        )}
      </div>
      {/* End left container */}

      {/* ── Version Panel (right sidebar) ────────────────────────────────── */}
      {versionPanelOpen && (
        <div className="w-72 shrink-0 bg-[#2a2a2a] border-l-2 border-[#007AFF] flex flex-col min-h-0 overflow-y-auto">
          <div className="px-3 pt-2 pb-1 flex items-center justify-between shrink-0">
            <span className="text-[11px] text-gray-400 font-medium flex items-center gap-1">
              <Layers size={12} /> 版本 ({versions.length})
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleImportVersion}
                className="px-2 py-0.5 text-[10px] bg-[#007AFF] text-white rounded hover:bg-[#0066CC] flex items-center gap-1"
              >
                <Upload size={10} /> 导入
              </button>
              {selectedVersions.some((v) => !v.isOriginal) && (
                <button
                  onClick={handleDeleteVersion}
                  className="px-2 py-0.5 text-[10px] bg-red-600 text-white rounded hover:bg-red-700 flex items-center gap-1"
                >
                  <Trash2 size={10} /> 删除
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 px-2 pb-2 space-y-0.5 overflow-y-auto">
            {versions.length === 0 ? (
              <div className="text-[11px] text-gray-500 px-2 py-1">暂无版本</div>
            ) : (
              versions.map((v) => (
                <div
                  key={v.id}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors',
                    selectedVersionIds.has(v.id)
                      ? 'bg-white/10 text-white'
                      : 'text-gray-400 hover:bg-white/5 hover:text-gray-200',
                    isRawFile(v.fileName) && !selectedVersionIds.has(v.id) && 'opacity-50'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selectedVersionIds.has(v.id)}
                    onChange={() => toggleVersion(v.id)}
                    disabled={isRawFile(v.fileName)}
                    className={cn(
                      'accent-[#007AFF] shrink-0',
                      isRawFile(v.fileName) ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
                    )}
                  />
                  <span className="w-16 shrink-0 font-medium truncate" title={v.versionName}>
                    {v.versionName}
                  </span>
                  <span className="text-gray-500 truncate flex-1 min-w-0">{v.fileName}</span>
                  <span className="text-gray-500 shrink-0">{fmtSize(v.fileSize)}</span>
                  {v.uploadedBy && <span className="text-gray-500 shrink-0">{v.uploadedBy}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Slide compare: two images with a draggable divider */
function SlideCompare({
  primary,
  secondary
}: {
  primary: ComparedVersion
  secondary: ComparedVersion
}) {
  const [pos, setPos] = useState(50)
  const [dragging, setDragging] = useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)

  const handleMouseDown = (): void => setDragging(true)
  const handleMouseUp = (): void => setDragging(false)
  const handleMouseMove = (e: React.MouseEvent): void => {
    if (!dragging || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const pct = ((e.clientX - rect.left) / rect.width) * 100
    setPos(Math.max(0, Math.min(100, pct)))
  }

  React.useEffect(() => {
    if (!dragging) return
    const up = (): void => setDragging(false)
    const move = (e: MouseEvent): void => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      setPos(Math.max(0, Math.min(100, pct)))
    }
    window.addEventListener('mouseup', up)
    window.addEventListener('mousemove', move)
    return () => {
      window.removeEventListener('mouseup', up)
      window.removeEventListener('mousemove', move)
    }
  }, [dragging])

  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden select-none"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseUp}
      style={{ cursor: 'col-resize' }}
    >
      {/* Left side label */}
      <div className="absolute top-2 left-2 z-10">
        <span className="text-[10px] text-white bg-black/60 px-2 py-0.5 rounded">
          {primary.version.versionName} · {primary.version.width}×{primary.version.height}
        </span>
      </div>
      {/* Right side label */}
      <div className="absolute top-2 right-2 z-10">
        <span className="text-[10px] text-white bg-black/60 px-2 py-0.5 rounded">
          {secondary.version.versionName} · {secondary.version.width}×{secondary.version.height}
        </span>
      </div>
      <img src={primary.url} alt="" className="absolute inset-0 w-full h-full object-contain" />
      <img
        src={secondary.url}
        alt=""
        className="absolute inset-0 w-full h-full object-contain"
        style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
      />
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg cursor-col-resize z-10"
        style={{ left: `${pos}%`, transform: 'translateX(-50%)' }}
        onMouseDown={(e) => {
          e.stopPropagation()
          setDragging(true)
        }}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-10 bg-white/90 rounded-full flex items-center justify-center text-black text-xs font-bold shadow-lg">
          ⟷
        </div>
      </div>
    </div>
  )
}

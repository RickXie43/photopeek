import React, { useState, useEffect } from 'react'
import { usePhotoStore } from '../../stores/photoStore'
import { useEventStore } from '../../stores/eventStore'
import { useUIStore } from '../../stores/uiStore'
import { cn } from '../../lib/cn'
import { PhotoVersion } from '../../types/photo'

export function InspectorPanel(): React.JSX.Element {
  const { photos, selectedPhotoIds, setPhotos, setLoading } = usePhotoStore()
  const { selectedEventId } = useEventStore()
  const { sortBy } = useUIStore()
  const selectedPhoto = photos.find((p) => selectedPhotoIds.has(p.id))
  const [eventTags, setEventTags] = useState<{ id: string; name: string; color: string }[]>([])
  const [photoTags, setPhotoTags] = useState<{ id: string; name: string; color: string }[]>([])
  const [filterTagIds, setFilterTagIds] = useState<Set<string>>(new Set())
  const [showAddTag, setShowAddTag] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [filterVersionNames, setFilterVersionNames] = useState<Set<string>>(new Set())
  const [eventVersionNames, setEventVersionNames] = useState<string[]>([])

  // Load all tags for current event
  useEffect(() => {
    if (!selectedEventId) { setEventTags([]); return }
    const loadTags = (): void => {
      window.electron.ipcRenderer.invoke('tags:list', selectedEventId).then((r: unknown) => {
        setEventTags(r as { id: string; name: string; color: string }[])
      }).catch(() => setEventTags([]))
    }
    loadTags()
    window.addEventListener('refresh-tags', loadTags)
    return () => window.removeEventListener('refresh-tags', loadTags)
  }, [selectedEventId])

  // Load version names for current event (for version filter)
  useEffect(() => {
    if (!selectedEventId) { setEventVersionNames([]); return }
    window.electron.ipcRenderer.invoke('photos:listVersionNames', selectedEventId)
      .then((r: unknown) => setEventVersionNames(r as string[]))
      .catch(() => setEventVersionNames([]))
  }, [selectedEventId])

  // Load tags for selected photo
  useEffect(() => {
    if (!selectedPhoto) { setPhotoTags([]); return }
    window.electron.ipcRenderer.invoke('tags:listForPhoto', selectedPhoto.id).then((r: unknown) => {
      setPhotoTags(r as { id: string; name: string; color: string }[])
    }).catch(() => setPhotoTags([]))
  }, [selectedPhoto?.id])

  // Filter photos when filterTagIds or filterVersionNames changes
  useEffect(() => {
    if (!selectedEventId) return
    setLoading(true)

    const hasTagFilter = filterTagIds.size > 0
    const hasVersionFilter = filterVersionNames.size > 0

    let promise: Promise<any>
    if (hasTagFilter && hasVersionFilter) {
      // Both filters active: first filter by version, then intersect with tag filter
      const tagIds = Array.from(filterTagIds)
      const versionNames = Array.from(filterVersionNames)
      promise = window.electron.ipcRenderer.invoke('photos:listByVersionNames', { eventId: selectedEventId, versionNames, sortBy })
        .then(async (byVersion: any) => {
          const byVersionIds = new Set(byVersion.map((p: any) => p.id))
          const byTag = await window.electron.ipcRenderer.invoke('photos:listByTags', { eventId: selectedEventId, tagIds, sortBy })
          return byTag.filter((p: any) => byVersionIds.has(p.id))
        })
    } else if (hasVersionFilter) {
      promise = window.electron.ipcRenderer.invoke('photos:listByVersionNames', { eventId: selectedEventId, versionNames: Array.from(filterVersionNames), sortBy })
    } else if (hasTagFilter) {
      promise = window.electron.ipcRenderer.invoke('photos:listByTags', { eventId: selectedEventId, tagIds: Array.from(filterTagIds), sortBy })
    } else {
      promise = window.electron.ipcRenderer.invoke('photos:listByEvent', selectedEventId, sortBy)
    }

    promise.then((result: any) => {
      setPhotos(result)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [filterTagIds, filterVersionNames, selectedEventId, sortBy])

  const toggleFilter = (tagId: string): void => {
    setFilterTagIds(prev => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId)
      else next.add(tagId)
      return new Set(next)
    })
  }

  // ── Version state ──────────────────────────────────────────────────────
  const [versions, setVersions] = useState<PhotoVersion[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedPhoto) { setVersions([]); setSelectedVersionId(null); return }
    window.electron.ipcRenderer.invoke('photos:listVersions', selectedPhoto.id)
      .then((r: unknown) => {
        const list = r as PhotoVersion[]
        setVersions(list)
        const orig = list.find((v: PhotoVersion) => v.isOriginal)
        setSelectedVersionId(orig ? orig.id : (list[0]?.id || null))
      })
      .catch(() => { setVersions([]) })
  }, [selectedPhoto?.id])

  // Derive display data from selected version, falling back to photo
  const activeVersion = versions.find(v => v.id === selectedVersionId)
  const displayFileName = activeVersion?.fileName || selectedPhoto?.fileName
  const displayFileSize = activeVersion?.fileSize || selectedPhoto?.fileSize || 0
  // Use version metadata dimensions when available (more reliable than stored width/height)
  const versionMetaWidth = activeVersion?.metadata?.imageWidth
  const versionMetaHeight = activeVersion?.metadata?.imageHeight
  const displayWidth = versionMetaWidth || activeVersion?.width || selectedPhoto?.width || 0
  const displayHeight = versionMetaHeight || activeVersion?.height || selectedPhoto?.height || 0
  const activeVersionMeta = activeVersion?.metadata || null
  const meta = activeVersionMeta || selectedPhoto?.metadata

  // Auto-refresh metadata for versions that have null metadata
  useEffect(() => {
    if (!activeVersion || activeVersion.metadata) return
    window.electron.ipcRenderer.invoke('photos:refreshMetadata', selectedPhoto!.id, activeVersion.id)
      .then((result: any) => {
        if (result.success) {
          // Update the version's metadata in state
          setVersions(prev => prev.map(v => v.id === activeVersion.id ? { ...v, metadata: result.metadata } : v))
        }
      })
      .catch(() => {})
  }, [activeVersion?.id])

  // Refresh metadata for the selected photo (manual trigger)
  const [refreshing, setRefreshing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  useEffect(() => {
    if (!selectedPhoto) return
    // If metadata is null/empty, try to refresh once
    if (!selectedPhoto.metadata || Object.keys(selectedPhoto.metadata).length === 0) {
      setRefreshing(true)
      setLoadFailed(false)
    }
  }, [selectedPhoto?.id])

  // Auto-refresh when needed
  useEffect(() => {
    if (!refreshing) return
    const doRefresh = async (): Promise<void> => {
      try {
        const result = await window.electron.ipcRenderer.invoke('photos:refreshMetadata', selectedPhoto!.id, selectedVersionId) as { success: boolean; metadata: any; debug?: string }
        if (result.success) {
          usePhotoStore.getState().updatePhoto(selectedPhoto!.id, { metadata: result.metadata })
        } else {
          setLoadFailed(true)
          console.error('Metadata refresh failed:', result.debug)
        }
      } catch {
        setLoadFailed(true)
      }
      setRefreshing(false)
    }
    doRefresh()
  }, [refreshing])

  useEffect(() => {
    if (!selectedPhoto) { setVersions([]); setSelectedVersionId(null); return }
    window.electron.ipcRenderer.invoke('photos:listVersions', selectedPhoto.id)
      .then((r: unknown) => {
        const list = r as PhotoVersion[]
        setVersions(list)
        // Default: select original version or first
        const orig = list.find((v: PhotoVersion) => v.isOriginal)
        setSelectedVersionId(orig ? orig.id : (list[0]?.id || null))
      })
      .catch(() => { setVersions([]) })
  }, [selectedPhoto?.id])

  const infoItems = selectedPhoto ? [
    { label: '文件名', value: displayFileName || selectedPhoto.fileName },
    { label: '大小', value: formatFileSize(displayFileSize) },
    { label: '分辨率', value: `${displayWidth} × ${displayHeight}` },
    selectedPhoto.rating > 0 && { label: '评分', value: '★'.repeat(selectedPhoto.rating) + '☆'.repeat(5 - selectedPhoto.rating) },
    selectedPhoto.flag && { label: '标记', value: selectedPhoto.flag === 'pick' ? '✅ 留用' : '❌ 弃用' },
    meta?.dateTimeOriginal && { label: '拍摄时间', value: meta.dateTimeOriginal },
    meta?.cameraMake && { label: '相机制造商', value: meta.cameraMake },
    meta?.cameraModel && { label: '相机型号', value: meta.cameraModel },
    meta?.lensModel && { label: '镜头', value: meta.lensModel },
    meta?.focalLength && { label: '焦距', value: `${meta.focalLength}mm` },
    meta?.aperture && { label: '光圈', value: `f/${meta.aperture}` },
    meta?.shutterSpeed && { label: '快门', value: `${meta.shutterSpeed}s` },
    meta?.iso && { label: 'ISO', value: String(meta.iso) },
    meta?.orientation && { label: '方向', value: String(meta.orientation) },
    meta?.fileType && { label: '文件类型', value: meta.fileType },
    activeVersion && { label: '当前版本', value: activeVersion.versionName },
    activeVersion?.uploadedBy && { label: '修改用户', value: activeVersion.uploadedBy },
    activeVersion?.uploadedAt && { label: '上传时间', value: new Date(activeVersion.uploadedAt).toLocaleString() },
    (meta?.gpsLatitude || meta?.gpsLongitude) && {
      label: 'GPS',
      value: `${meta.gpsLatitude?.toFixed(4) ?? '?'}, ${meta.gpsLongitude?.toFixed(4) ?? '?'}`,
    },
    meta?.gpsAltitude && { label: '海拔', value: `${meta.gpsAltitude.toFixed(1)}m` },
  ].filter(Boolean) as { label: string; value: string }[] : []

  return (
    <aside className="w-72 bg-[var(--color-sidebar)] border-l border-[var(--color-border)] flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="h-10 flex items-center gap-2 px-4 border-b border-[var(--color-border)] shrink-0">
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 shrink-0">信息</span>
        {versions.length > 0 && (
          <select
            value={selectedVersionId ?? ''}
            onChange={(e) => setSelectedVersionId(e.target.value || null)}
            className="text-[10px] bg-transparent border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 text-gray-600 dark:text-gray-300 max-w-[140px] truncate focus:outline-none"
          >
            {versions.map(v => (
              <option key={v.id} value={v.id}>
                {v.versionName} {v.isOriginal ? '★' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Main content area */}
      <div className="flex-1 overflow-y-auto">
        {!selectedPhoto ? (
          <div className="py-6 text-center">
            <div className="text-3xl mb-2">🖼️</div>
            <div className="text-xs text-gray-400">
              {selectedPhotoIds.size === 0 ? '未选择照片' : `已选择 ${selectedPhotoIds.size} 张照片`}
            </div>
          </div>
        ) : (
          <>
            {/* Metadata (compact) */}
            <div className="px-4 py-2.5 space-y-1.5">
              {refreshing && <div className="text-xs text-gray-400 animate-pulse">正在读取元数据...</div>}
              {loadFailed && (
                <div className="text-xs text-red-400 mb-2">
                  元数据读取失败
                  <button onClick={() => setRefreshing(true)} className="ml-2 text-[#007AFF] hover:underline">重试</button>
                </div>
              )}
              {infoItems.map((item) => (
                <div key={item.label} className="flex items-start gap-2">
                  <span className="text-[11px] text-gray-400 shrink-0 w-14 pt-0.5">{item.label}</span>
                  <span className="text-sm text-gray-800 dark:text-gray-200 truncate">{item.value}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Current photo tags — always visible above tag filter */}
      <div className="border-t border-[var(--color-border)] shrink-0">
        <div className="px-4 py-3">
          <span className="text-[11px] text-gray-400 uppercase tracking-wider block mb-1.5">当前标签</span>
          <div className="flex flex-wrap gap-1.5 min-h-[1.25rem] items-center">
            {photoTags.length > 0 ? (
              photoTags.map(tag => (
                <span
                  key={tag.id}
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{
                    backgroundColor: tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.3)'),
                    color: tag.color,
                  }}
                >
                  {tag.name}
                </span>
              ))
            ) : (
              <span className="text-[10px] text-gray-400">—</span>
            )}

            {/* Add tag button */}
            {selectedPhoto && !showAddTag && (
              <button
                onClick={() => setShowAddTag(true)}
                className="w-5 h-5 flex items-center justify-center rounded-full border border-dashed border-gray-400 text-gray-400 hover:border-[#007AFF] hover:text-[#007AFF] transition-colors text-xs leading-none"
                title="添加标签"
              >
                +
              </button>
            )}

            {/* Inline add tag input */}
            {showAddTag && (
              <div className="flex items-center gap-1 w-full mt-1">
                <input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="输入标签名..."
                  className="flex-1 px-2 py-1 text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-[#007AFF]"
                  autoFocus
                  onKeyDown={async (e) => {
                    if (e.key === 'Escape') { setShowAddTag(false); setNewTagName(''); return }
                    if (e.key !== 'Enter' || !newTagName.trim() || !selectedPhoto) return
                    try {
                      const created = await window.electron.ipcRenderer.invoke('tags:create', {
                        eventId: selectedPhoto.eventId,
                        name: newTagName.trim(),
                      }) as { id: string; name: string; color: string; error?: string }
                      if (created.error) return
                      await window.electron.ipcRenderer.invoke('tags:addToPhoto', {
                        photoId: selectedPhoto.id,
                        tagId: created.id,
                        eventId: selectedPhoto.eventId,
                      })
                      setPhotoTags(prev => [...prev, { id: created.id, name: created.name, color: created.color }])
                      setNewTagName('')
                      setShowAddTag(false)
                      window.dispatchEvent(new Event('refresh-tags'))
                    } catch {}
                  }}
                  onBlur={() => { setShowAddTag(false); setNewTagName('') }}
                />
                <button
                  onClick={() => { setShowAddTag(false); setNewTagName('') }}
                  className="text-[10px] text-gray-400 hover:text-gray-600"
                >
                  取消
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tag filter — always visible */}
      <div className="border-t border-[var(--color-border)] shrink-0">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-gray-400 uppercase tracking-wider">标签筛选</span>
            {filterTagIds.size > 0 && (
              <button
                onClick={() => setFilterTagIds(new Set())}
                className="text-[10px] text-[#007AFF] hover:underline"
              >
                清除筛选
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-[4.5rem] overflow-y-auto">
            {eventTags.length === 0 ? (
              <span className="text-[10px] text-gray-400">暂无标签</span>
            ) : (
              eventTags.map(tag => {
                const active = filterTagIds.has(tag.id)
                const fadedColor = tag.color.replace('hsl(', 'hsla(').replace(')', ', 0.3)')
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleFilter(tag.id)}
                    className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-medium transition-all',
                      active ? 'ring-1 ring-offset-1 ring-offset-transparent' : 'opacity-60 hover:opacity-100'
                    )}
                    style={{
                      backgroundColor: active ? tag.color : fadedColor,
                      color: active ? '#fff' : tag.color,
                      outline: active ? '2px solid ' + tag.color : 'none',
                    }}
                  >
                    {tag.name}
                    {active && filterTagIds.size > 1 && (
                      <span className="ml-1 opacity-70">✓</span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* Version filter — below tag filter */}
      <div className="border-t border-[var(--color-border)] shrink-0">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-gray-400 uppercase tracking-wider">版本筛选</span>
            {filterVersionNames.size > 0 && (
              <button
                onClick={() => setFilterVersionNames(new Set())}
                className="text-[10px] text-[#007AFF] hover:underline"
              >
                清除筛选
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-[4.5rem] overflow-y-auto">
            {eventVersionNames.length === 0 ? (
              <span className="text-[10px] text-gray-400">暂无版本</span>
            ) : (
              eventVersionNames.map(name => {
                const active = filterVersionNames.has(name)
                const abbr = name.includes('修图') || name.includes('上传') || name.includes('手机') || name.includes('_')
                  ? name.replace(/_/g, ' · ')
                  : name
                const isUserVersion = name.includes('修图') || name.includes('上传') || name.includes('手机') || name.includes('_')
                return (
                  <button
                    key={name}
                    onClick={() => {
                      setFilterVersionNames(prev => {
                        const next = new Set(prev)
                        if (next.has(name)) next.delete(name)
                        else next.add(name)
                        return next
                      })
                    }}
                    className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-medium transition-all',
                      active ? 'ring-1 ring-offset-1 ring-offset-transparent text-white' : 'opacity-60 hover:opacity-100'
                    )}
                    style={{
                      backgroundColor: active
                        ? (isUserVersion ? '#16a34a' : '#6366f1')
                        : (isUserVersion ? 'rgba(22,163,74,0.3)' : 'rgba(99,102,241,0.3)'),
                      color: active ? '#fff' : (isUserVersion ? '#16a34a' : '#6366f1'),
                      outline: active ? `2px solid ${isUserVersion ? '#16a34a' : '#6366f1'}` : 'none',
                    }}
                  >
                    {abbr}
                    {active && filterVersionNames.size > 1 && (
                      <span className="ml-1 opacity-70">✓</span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { useEventStore } from '../../stores/eventStore'
import { useUIStore } from '../../stores/uiStore'
import {
  FolderOpen,
  Save,
  Trash2,
  Pencil,
  X,
  Upload,
  ChevronDown,
  ChevronUp,
  ImageIcon,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import type {
  Tag,
  VersionFilterMode,
  OverwriteMode,
  ExportProgress,
  ExportResult,
  ExportPreset,
  Photo,
} from '../../types/photo'

const TEMPLATE_PRESETS: { label: string; template: string }[] = [
  { label: '扁平', template: '{originalName}{extension}' },
  { label: '按版本', template: '{version}/{originalName}{extension}' },
  { label: '按标签', template: '{firstTag}/{originalName}{extension}' },
  { label: '按日期', template: '{year}/{month}/{originalName}{extension}' },
  { label: '按评分', template: '{rating}★/{originalName}{extension}' },
]

const DEFAULT_ORGANIZE_TEMPLATE = '{originalName}{extension}'

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + units[i]
}

export function ExportDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { selectedEventId, events } = useEventStore()
  const eventName = events.find((e) => e.id === selectedEventId)?.name || ''
  const {
    exportPresets,
    saveExportPreset,
    deleteExportPreset,
    renameExportPreset,
  } = useUIStore()

  // ── Core state ──
  const [tags, setTags] = useState<Tag[]>([])
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set())
  const [previewPhotos, setPreviewPhotos] = useState<Photo[]>([])

  // ── Advanced state ──
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [destinationFolder, setDestinationFolder] = useState('')
  const [versionFilterMode, setVersionFilterMode] =
    useState<VersionFilterMode>('all')
  const [selectedVersionNames, setSelectedVersionNames] = useState<Set<string>>(
    new Set()
  )
  const [allVersionNames, setAllVersionNames] = useState<string[]>([])
  const [organizeTemplate, setOrganizeTemplate] = useState(
    DEFAULT_ORGANIZE_TEMPLATE
  )
  const [overwriteMode, setOverwriteMode] = useState<OverwriteMode>('skip')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [showSavePreset, setShowSavePreset] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [managePresets, setManagePresets] = useState(false)
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // ── Execution state ──
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)

  // Reset on open
  useEffect(() => {
    if (open) {
      setSelectedTagIds(new Set())
      setPreviewPhotos([])
      setShowAdvanced(false)
      setDestinationFolder('')
      setVersionFilterMode('all')
      setSelectedVersionNames(new Set())
      setOrganizeTemplate(DEFAULT_ORGANIZE_TEMPLATE)
      setOverwriteMode('skip')
      setExporting(false)
      setProgress(null)
      setResult(null)
      setSelectedPresetId(null)
      setShowSavePreset(false)
      setManagePresets(false)
    }
  }, [open])

  // Load tags and version names
  useEffect(() => {
    if (!open || !selectedEventId) return
    Promise.all([
      window.electron.ipcRenderer.invoke('tags:list', selectedEventId) as Promise<Tag[]>,
      window.electron.ipcRenderer.invoke(
        'photos:listVersionNames',
        selectedEventId
      ) as Promise<string[]>,
    ])
      .then(([tagList, versionNames]) => {
        setTags(tagList)
        setAllVersionNames(versionNames)
      })
      .catch(console.error)
  }, [open, selectedEventId])

  // Reload preview when tag or version selection changes
  useEffect(() => {
    if (!open || !selectedEventId) return
    const loadPreview = async (): Promise<void> => {
      try {
        const tagIds = Array.from(selectedTagIds)
        let photos: Photo[]
        if (tagIds.length === 0) {
          // No tags → all photos
          photos = (await window.electron.ipcRenderer.invoke(
            'photos:listByTagsOr',
            { eventId: selectedEventId, tagIds: [] }
          )) as Photo[]
        } else {
          // With tags → AND (intersection) mode
          photos = (await window.electron.ipcRenderer.invoke(
            'photos:listByTags',
            { eventId: selectedEventId, tagIds }
          )) as Photo[]
        }
        setPreviewPhotos(photos)
      } catch (err) {
        console.error('[Export] Preview load failed:', err)
      }
    }
    loadPreview()
  }, [open, selectedEventId, selectedTagIds])

  // Listen for progress
  useEffect(() => {
    const handler = (_event: unknown, p: ExportProgress): void => {
      if (p) setProgress(p)
    }
    window.electron.ipcRenderer.on(
      'export:progress',
      handler as (...args: unknown[]) => void
    )
    return () => {
      window.electron.ipcRenderer.removeListener(
        'export:progress',
        handler as (...args: unknown[]) => void
      )
    }
  }, [])

  // ── Tag toggle ──
  const toggleTag = useCallback((tagId: string): void => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId)
      else next.add(tagId)
      return next
    })
  }, [])

  // ── Version toggle ──
  const toggleVersion = useCallback((name: string): void => {
    setSelectedVersionNames((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  // ── Preset ──
  const loadPreset = useCallback((preset: ExportPreset): void => {
    const opts = preset.options
    setVersionFilterMode(opts.versionFilter.mode)
    setSelectedVersionNames(new Set(opts.versionFilter.selectedVersionNames))
    setOrganizeTemplate(opts.organizeTemplate)
    setOverwriteMode(opts.overwriteMode)
    setSelectedPresetId(preset.id)
  }, [])

  const handlePresetChange = useCallback(
    (presetId: string): void => {
      if (presetId === '__default__') {
        setVersionFilterMode('all')
        setSelectedVersionNames(new Set())
        setOrganizeTemplate(DEFAULT_ORGANIZE_TEMPLATE)
        setOverwriteMode('skip')
        setSelectedPresetId(null)
        return
      }
      const preset = exportPresets.find((p) => p.id === presetId)
      if (preset) loadPreset(preset)
    },
    [exportPresets, loadPreset]
  )

  const handleSavePreset = useCallback((): void => {
    const name = newPresetName.trim()
    if (!name) return
    saveExportPreset(name, {
      versionFilter: {
        mode: versionFilterMode,
        selectedVersionNames: Array.from(selectedVersionNames),
      },
      tagFilter: null,
      organizeTemplate,
      overwriteMode,
    })
    setNewPresetName('')
    setShowSavePreset(false)
  }, [
    newPresetName,
    versionFilterMode,
    selectedVersionNames,
    organizeTemplate,
    overwriteMode,
    saveExportPreset,
  ])

  // ── Filter preview photos by version selection ──
  const filteredPhotos = useMemo((): Photo[] => {
    if (selectedVersionNames.size === 0) return previewPhotos
    return previewPhotos.filter((photo) => {
      let versions: string[] = []
      try {
        if (photo.versionSummary) versions = JSON.parse(photo.versionSummary)
      } catch { /* ignore */ }
      return versions.some((v) => selectedVersionNames.has(v))
    })
  }, [previewPhotos, selectedVersionNames])

  // ── Template preview ──
  const templatePreview = useMemo((): string[] => {
    const examples = [
      { originalName: 'DSC_001', extension: '.jpg', version: 'RAW', firstTag: '风景', tags: '风景,旅行', year: '2026', month: '06', day: '15', date: '2026-06-15', rating: '5', flag: 'pick' },
      { originalName: 'DSC_002', extension: '.jpg', version: 'JPEG', firstTag: '人像', tags: '人像', year: '2026', month: '06', day: '15', date: '2026-06-15', rating: '3', flag: 'none' },
    ]
    return examples.map((ex) => {
      let path = organizeTemplate
      for (const [k, v] of Object.entries(ex)) {
        path = path.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
      }
      return path
    })
  }, [organizeTemplate])

  // ── Export ──
  const handleExport = useCallback(async (): Promise<void> => {
    if (!selectedEventId) return

    const parentFolder = (await window.electron.ipcRenderer.invoke(
      'export:selectFolder'
    )) as string | null
    if (!parentFolder) return

    const tagNames = tags
      .filter((t) => selectedTagIds.has(t.id))
      .map((t) => t.name)
    const tagSuffix = tagNames.length > 0 ? `_${tagNames.join('_')}` : ''
    const timeStr = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[T:]/g, '')
      .slice(0, 14)
    const folderName = `${eventName}${tagSuffix}_${timeStr}`
    const resolvedDest =
      showAdvanced && destinationFolder
        ? destinationFolder
        : `${parentFolder}/${folderName}`

    const tagFilter =
      selectedTagIds.size > 0
        ? {
            mode: 'intersection' as const,
            includeTagIds: Array.from(selectedTagIds),
            excludeTagIds: [] as string[],
          }
        : null

    setExporting(true)
    setResult(null)
    setProgress({ current: 0, total: 0, message: '准备导出...', percent: 0 })

    try {
      const res = (await window.electron.ipcRenderer.invoke('export:execute', {
        eventId: selectedEventId,
        destinationFolder: resolvedDest,
        versionFilter: {
          mode: versionFilterMode,
          selectedVersionNames: Array.from(selectedVersionNames),
        },
        tagFilter,
        organizeTemplate,
        overwriteMode,
      })) as ExportResult
      setResult(res)
      setProgress(null)
    } catch (err) {
      console.error('[Export] Failed:', err)
      setResult({
        success: false,
        exported: 0,
        skipped: 0,
        errors: [(err as Error).message],
      })
      setProgress(null)
    } finally {
      setExporting(false)
    }
  }, [
    selectedEventId,
    tags,
    selectedTagIds,
    eventName,
    showAdvanced,
    destinationFolder,
    versionFilterMode,
    selectedVersionNames,
    organizeTemplate,
    overwriteMode,
  ])

  const handleCancel = useCallback(async (): Promise<void> => {
    await window.electron.ipcRenderer.invoke('export:cancel')
  }, [])

  const handleClose = useCallback((): void => {
    if (exporting) {
      handleCancel()
      return
    }
    setResult(null)
    setProgress(null)
    onClose()
  }, [exporting, handleCancel, onClose])

  // ── Thumbnail URL helper ──
  const toThumbUrl = (photo: Photo): string | null => {
    const thumbPath = photo.thumbnailPath
    if (!thumbPath) return null
    if (thumbPath.startsWith('/') || /^[A-Za-z]:\\/.test(thumbPath)) {
      return `photo:///${thumbPath.replace(/\\/g, '/')}`
    }
    return thumbPath
  }

  // ── Render ──
  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="导出"
      className="max-w-lg"
      closeOnOverlayClick={false}
    >
      <div className="space-y-4">
        {/* Event name */}
        <div className="text-xs text-gray-500">
          事件：<span className="font-medium text-gray-700 dark:text-gray-300">{eventName}</span>
        </div>

        {/* ═══ Tag selection ═══ */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">标签筛选（交集）</label>
            {selectedTagIds.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedTagIds(new Set())}
                className="text-[10px] text-gray-400 hover:text-red-500 transition-colors"
              >
                清除
              </button>
            )}
          </div>
          {tags.length === 0 ? (
            <p className="text-xs text-gray-400">此事件暂无标签，将导出全部照片</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => {
                const checked = selectedTagIds.has(tag.id)
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className={cn(
                      'inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full border transition-colors',
                      checked
                        ? 'border-transparent text-white'
                        : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-400'
                    )}
                    style={
                      checked
                        ? { backgroundColor: tag.color, borderColor: tag.color }
                        : undefined
                    }
                  >
                    {checked ? '✓ ' : ''}
                    {tag.name}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* ═══ Version selection ═══ */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">版本筛选</label>
            {selectedVersionNames.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedVersionNames(new Set())}
                className="text-[10px] text-gray-400 hover:text-red-500 transition-colors"
              >
                清除
              </button>
            )}
          </div>
          {allVersionNames.length === 0 ? (
            <p className="text-xs text-gray-400">暂无版本信息</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {allVersionNames.map((name) => {
                const checked = selectedVersionNames.has(name)
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleVersion(name)}
                    className={cn(
                      'px-2 py-0.5 text-xs rounded-full border transition-colors',
                      checked
                        ? 'bg-[#007AFF] text-white border-[#007AFF]'
                        : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-400'
                    )}
                  >
                    {checked ? '✓ ' : ''}
                    {name}
                  </button>
                )
              })}
            </div>
          )}
          {selectedVersionNames.size === 0 && (
            <p className="text-[10px] text-gray-400 mt-1">未选择版本 — 将导出所有版本</p>
          )}
        </div>

        {/* ═══ Preview horizontal list ═══ */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              匹配结果
            </span>
            <span className="text-xs text-gray-400">
              共 <span className="font-medium text-gray-600 dark:text-gray-300">{filteredPhotos.length}</span> 张照片
            </span>
          </div>
          {filteredPhotos.length > 0 ? (
            <div className="max-h-60 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
              {filteredPhotos.map((photo) => {
                const src = toThumbUrl(photo)
                let versions: string[] = []
                try {
                  if (photo.versionSummary) versions = JSON.parse(photo.versionSummary)
                } catch { /* ignore */ }
                const formatLabel = versions.length > 0 ? versions.join(' / ') : ''
                return (
                  <div
                    key={photo.id}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <div className="w-8 h-8 rounded overflow-hidden bg-gray-200 dark:bg-gray-700 shrink-0 relative">
                      {src ? (
                        <img
                          src={src}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            const el = e.target as HTMLImageElement
                            el.style.display = 'none'
                            const fb = el.nextElementSibling as HTMLElement
                            if (fb) fb.style.display = 'flex'
                          }}
                        />
                      ) : null}
                      <span className="absolute inset-0 hidden items-center justify-center text-[10px] text-gray-500">
                        <ImageIcon size={14} />
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate text-gray-800 dark:text-gray-200">
                        {photo.fileName}
                      </div>
                      <div className="text-xs text-gray-400">
                        {formatLabel && <span className="mr-2">{formatLabel}</span>}
                        <span>{formatSize(photo.fileSize)}</span>
                        {photo.width && photo.height && (
                          <span className="ml-2">{photo.width}×{photo.height}</span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-xs text-gray-400 py-3 text-center bg-gray-50 dark:bg-gray-700/30 rounded-lg">
              {selectedTagIds.size === 0 && selectedVersionNames.size === 0
                ? '将导出事件内所有照片'
                : '没有匹配筛选条件的照片'}
            </div>
          )}
        </div>

        {/* ═══ Folder name preview ═══ */}
        {!showAdvanced && (
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-2.5 text-xs space-y-1">
            <div className="text-gray-500">导出文件夹：</div>
            <div className="font-mono text-gray-700 dark:text-gray-300 break-all">
              <FolderOpen size={12} className="inline mr-1 text-gray-400" />
              {'…/'}
              <span className="text-[#007AFF]">
                {eventName}
                {selectedTagIds.size > 0
                  ? `_${tags.filter((t) => selectedTagIds.has(t.id)).map((t) => t.name).join('_')}`
                  : ''}
                _{new Date().toISOString().slice(0, 19).replace(/[T:]/g, '').slice(0, 14)}
              </span>
              /
            </div>
            <div className="text-gray-400">点击「导出」后选择目标父文件夹</div>
          </div>
        )}

        {/* ═══ Advanced toggle ═══ */}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            高级选项
          </button>

          {showAdvanced && (
            <div className="space-y-4 mt-3">
              {/* Destination folder */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">目标文件夹</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={destinationFolder}
                    readOnly
                    placeholder="留空则自动创建事件名_标签_时间文件夹"
                    className="flex-1 px-3 py-1.5 text-xs bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-500"
                  />
                  <Button variant="default" size="sm" onClick={async () => {
                    const folder = (await window.electron.ipcRenderer.invoke('export:selectFolder')) as string | null
                    if (folder) setDestinationFolder(folder)
                  }}>
                    <FolderOpen size={14} />
                  </Button>
                </div>
              </div>

              {/* Presets */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">导出预设</label>
                <div className="flex items-center gap-2">
                  <select
                    value={selectedPresetId ?? '__default__'}
                    onChange={(e) => handlePresetChange(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF]"
                  >
                    <option value="__default__">— 默认配置 —</option>
                    {exportPresets.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <Button variant="ghost" size="sm" onClick={() => { setNewPresetName(''); setShowSavePreset(true) }} title="另存为预设"><Save size={14} /></Button>
                  <Button variant="ghost" size="sm" onClick={() => setManagePresets(!managePresets)} title="管理预设"><FolderOpen size={14} /></Button>
                </div>
                {showSavePreset && (
                  <div className="flex gap-2 mt-1.5">
                    <input type="text" value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)} placeholder="预设名称..." className="flex-1 px-3 py-1.5 text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF]" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') handleSavePreset(); if (e.key === 'Escape') setShowSavePreset(false) }} autoFocus />
                    <Button variant="primary" size="sm" onClick={handleSavePreset} disabled={!newPresetName.trim()}>保存</Button>
                    <Button variant="ghost" size="sm" onClick={() => setShowSavePreset(false)}><X size={14} /></Button>
                  </div>
                )}
                {managePresets && exportPresets.length > 0 && (
                  <div className="space-y-1 mt-1.5 max-h-24 overflow-y-auto">
                    {exportPresets.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">
                        {renamingPresetId === p.id ? (
                          <input type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} className="flex-1 px-2 py-0.5 text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-[#007AFF]" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && renameValue.trim()) { renameExportPreset(p.id, renameValue.trim()); setRenamingPresetId(null) } if (e.key === 'Escape') setRenamingPresetId(null) }} autoFocus />
                        ) : (
                          <span className="flex-1 text-xs text-gray-700 dark:text-gray-300">{p.name}</span>
                        )}
                        <button onClick={() => { setRenamingPresetId(p.id); setRenameValue(p.name) }} className="p-0.5 text-gray-400 hover:text-gray-600" title="重命名"><Pencil size={12} /></button>
                        <button onClick={() => { if (selectedPresetId === p.id) setSelectedPresetId(null); deleteExportPreset(p.id) }} className="p-0.5 text-gray-400 hover:text-red-500" title="删除"><Trash2 size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Template */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">输出整理</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {TEMPLATE_PRESETS.map((preset) => (
                    <button key={preset.label} type="button" onClick={() => setOrganizeTemplate(preset.template)}
                      className={cn('px-2 py-0.5 text-xs rounded-lg border transition-colors', organizeTemplate === preset.template ? 'bg-[#007AFF] text-white border-[#007AFF]' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-400')}>
                      {preset.label}
                    </button>
                  ))}
                </div>
                <input type="text" value={organizeTemplate} onChange={(e) => setOrganizeTemplate(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF] font-mono mb-1.5"
                  onKeyDown={(e) => e.stopPropagation()} />
                <div className="text-[10px] text-gray-400 space-y-0.5">
                  <span className="font-medium">预览：</span>
                  {templatePreview.map((p, i) => <div key={i} className="truncate">{p}</div>)}
                </div>
              </div>

              {/* Overwrite */}
              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400">重复文件：</label>
                {([{ value: 'skip' as OverwriteMode, label: '跳过' }, { value: 'replace' as OverwriteMode, label: '覆盖' }]).map((opt) => (
                  <button key={opt.value} type="button" onClick={() => setOverwriteMode(opt.value)}
                    className={cn('px-2.5 py-1 text-xs font-medium rounded-lg transition-colors', overwriteMode === opt.value ? 'bg-[#007AFF] text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600')}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ═══ Progress ═══ */}
        {progress && (
          <div>
            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
              <span>{progress.message}</span>
              <span>{progress.current}/{progress.total}</span>
            </div>
            <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-[#007AFF] rounded-full transition-all duration-200" style={{ width: `${progress.percent}%` }} />
            </div>
          </div>
        )}

        {/* ═══ Result ═══ */}
        {result && (
          <div className={cn('p-3 rounded-lg text-xs space-y-1', result.success ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-300')}>
            <div className="font-medium">{result.success ? '✅ 导出完成' : '⚠️ 导出完成（有错误）'}</div>
            <div>成功导出：{result.exported} 张</div>
            {result.skipped > 0 && <div>跳过：{result.skipped} 张</div>}
            {result.errors.length > 0 && (
              <div>
                <div>错误：{result.errors.length} 项</div>
                <ul className="list-disc list-inside text-[10px] opacity-80 max-h-20 overflow-y-auto">
                  {result.errors.slice(0, 20).map((err, i) => <li key={i}>{err}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* ═══ Actions ═══ */}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="default" size="sm" onClick={handleClose}>
            {exporting ? '取消' : '关闭'}
          </Button>
          <Button variant="primary" size="sm" onClick={handleExport} disabled={exporting}>
            {exporting ? (
              <span className="animate-pulse">导出中...</span>
            ) : (
              <><Upload size={14} />导出</>
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

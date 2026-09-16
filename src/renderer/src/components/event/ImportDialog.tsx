import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { useEventStore } from '../../stores/eventStore'
import {
  Upload,
  FileImage,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Plus,
  FolderOpen,
  File,
  Edit3,
  Link2
} from 'lucide-react'
import { cn } from '../../lib/cn'

interface PreviewFile {
  path: string
  name: string
  size: number
  ext: string
}

interface EventPackagePreview {
  valid: boolean
  error?: string
  eventName: string
  folderName: string
  photoCount: number
  versionCount: number
  missingFiles: string[]
}

export function ImportDialog({
  open,
  onClose,
  onImportComplete
}: {
  open: boolean
  onClose: () => void
  onImportComplete?: () => void
}): React.JSX.Element {
  const { events, selectedEventId, addEvent, setSelectedEvent } = useEventStore()
  const [targetEventId, setTargetEventId] = useState('')
  const [previewFiles, setPreviewFiles] = useState<PreviewFile[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{
    imported: number
    skipped: number
    errors: string[]
    errorDetails?: string[]
    totalError?: string
    merged?: number
  } | null>(null)
  const [importMode, setImportMode] = useState<'original' | 'retouched'>('original')
  const [versionName, setVersionName] = useState('')
  const [progress, setProgress] = useState<{
    current: number
    total: number
    message: string
    percent: number
  } | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [importKind, setImportKind] = useState<'photos' | 'event'>('photos')
  const [eventPackagePath, setEventPackagePath] = useState('')
  const [eventPackagePreview, setEventPackagePreview] = useState<EventPackagePreview | null>(null)

  // Sync target event with sidebar selection when dialog opens
  useEffect(() => {
    if (open) {
      setTargetEventId(selectedEventId || '')
    }
  }, [open, selectedEventId])

  // Load nickname on first switch to retouched mode
  useEffect(() => {
    if (importMode === 'retouched' && !versionName) {
      window.electron.ipcRenderer
        .invoke('settings:get')
        .then((config: any) => {
          if (config?.nickname) setVersionName(config.nickname)
        })
        .catch(() => {})
    }
  }, [importMode])

  // Listen for import progress
  useEffect(() => {
    const handler = (...args: unknown[]) => {
      const p = args[1] as { current: number; total: number; message: string; percent: number }
      if (p) setProgress(p)
    }
    window.electron.ipcRenderer.on('import:progress', handler as (...args: unknown[]) => void)
    return () => {
      window.electron.ipcRenderer.removeListener(
        'import:progress',
        handler as (...args: unknown[]) => void
      )
    }
  }, [])

  // Quick event creation
  const [showNewEventInput, setShowNewEventInput] = useState(false)
  const [creatingEvent, setCreatingEvent] = useState(false)
  const newEventInputRef = useRef<HTMLInputElement>(null)

  const handleCreateEvent = async (): Promise<void> => {
    const name = newEventInputRef.current?.value?.trim()
    if (!name) return
    setCreatingEvent(true)
    try {
      const event = (await window.electron.ipcRenderer.invoke('events:create', {
        name
      })) as { id: string; name: string }
      addEvent(event as any)
      setTargetEventId(event.id)
      if (newEventInputRef.current) newEventInputRef.current.value = ''
      setShowNewEventInput(false)
    } catch (err) {
      console.error('Failed to create event:', err)
    } finally {
      setCreatingEvent(false)
    }
  }

  const addFiles = useCallback(async (paths: string[]): Promise<void> => {
    const files = (await window.electron.ipcRenderer.invoke(
      'import:preview',
      paths
    )) as PreviewFile[]
    setPreviewFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path))
      const newFiles = files.filter((f) => !existing.has(f.path))
      return [...prev, ...newFiles]
    })
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      files.forEach((f) => next.add(f.path))
      return next
    })
    setResult(null)
  }, [])

  const handleSelectFolder = useCallback(async (): Promise<void> => {
    const folder = await window.electron.ipcRenderer.invoke('import:selectFolder')
    if (!folder) return
    const files = (await window.electron.ipcRenderer.invoke(
      'import:scanFolder',
      folder
    )) as PreviewFile[]
    if (previewFiles.length === 0) {
      setPreviewFiles(files)
      setSelectedPaths(new Set(files.map((f) => f.path)))
    } else {
      await addFiles(files.map((f) => f.path))
    }
    setResult(null)
  }, [previewFiles.length, addFiles])

  const handleSelectFiles = useCallback(async (): Promise<void> => {
    const files = (await window.electron.ipcRenderer.invoke('import:selectFiles')) as
      | string[]
      | null
    if (!files || files.length === 0) return
    await addFiles(files)
  }, [addFiles])

  const handleDrop = useCallback(
    async (e: React.DragEvent): Promise<void> => {
      e.preventDefault()
      const items = Array.from(e.dataTransfer.files)
      const allPaths: string[] = []
      for (const item of items) {
        const p = (item as File & { path?: string }).path
        if (p) allPaths.push(p)
      }
      if (allPaths.length > 0) await addFiles(allPaths)
    },
    [addFiles]
  )

  const toggleFile = (filePath: string): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  const selectAll = (): void => {
    setSelectedPaths(new Set(previewFiles.map((f) => f.path)))
  }

  const deselectAll = (): void => {
    setSelectedPaths(new Set())
  }

  const handleStartImport = async (): Promise<void> => {
    if (importKind === 'event') {
      if (!eventPackagePath || !eventPackagePreview?.valid) return
      setImporting(true)
      setResult(null)
      setProgress({
        current: 0,
        total: eventPackagePreview.versionCount,
        message: '准备导入事件...',
        percent: 0
      })
      try {
        const res = (await window.electron.ipcRenderer.invoke(
          'import:executeEvent',
          eventPackagePath
        )) as any
        setResult({
          imported: res.imported || 0,
          skipped: res.skipped || 0,
          errors: res.errors || [],
          totalError: res.success ? undefined : res.errors?.[0] || '事件导入失败',
          merged: 0
        })
        setProgress(null)
        if (res.imported > 0) {
          if (res.eventId) setSelectedEvent(res.eventId)
          setTimeout(() => onImportComplete?.(), 500)
        }
      } catch (err) {
        setResult({
          imported: 0,
          skipped: 0,
          errors: [],
          totalError: err instanceof Error ? err.message : '事件导入失败'
        })
        setProgress(null)
      } finally {
        setImporting(false)
      }
      return
    }
    const selected = Array.from(selectedPaths)
    if (!targetEventId || selected.length === 0) return
    setImporting(true)
    setResult(null)
    setProgress({ current: 0, total: selected.length, message: '准备导入...', percent: 0 })
    setCancelling(false)

    try {
      const res = (await window.electron.ipcRenderer.invoke('import:execute', {
        eventId: targetEventId,
        filePaths: selected,
        importMode,
        versionName: importMode === 'retouched' ? versionName || '修图版本' : undefined
      })) as {
        imported: number
        skipped: number
        errors: string[]
        errorDetails?: string[]
        totalError?: string
        merged?: number
      }
      setResult(res)
      setProgress(null)

      // Notify parent to refresh photos
      if (res.imported > 0) {
        setTimeout(() => onImportComplete?.(), 500)
      }
    } catch (err) {
      console.error('Import failed:', err)
      setResult({
        imported: 0,
        skipped: 0,
        errors: [],
        totalError: err instanceof Error ? err.message : '导入失败'
      })
      setProgress(null)
    } finally {
      setImporting(false)
      setCancelling(false)
    }
  }

  const handleClose = (): void => {
    if (importing && !cancelling) {
      setCancelling(true)
      setProgress((prev) => (prev ? { ...prev, message: '正在取消...' } : null))
      window.electron.ipcRenderer.send('import:cancel')
      // Don't close immediately — wait for cancel to propagate
      return
    }
    setPreviewFiles([])
    setSelectedPaths(new Set())
    setResult(null)
    setImporting(false)
    setCancelling(false)
    setProgress(null)
    setShowNewEventInput(false)
    setImportMode('original')
    setVersionName('')
    setImportKind('photos')
    setEventPackagePath('')
    setEventPackagePreview(null)
    onClose()
  }

  const handleSelectEventPackage = useCallback(async (): Promise<void> => {
    const folder = (await window.electron.ipcRenderer.invoke('import:selectEventFolder')) as
      | string
      | null
    if (!folder) return
    const preview = (await window.electron.ipcRenderer.invoke(
      'import:previewEvent',
      folder
    )) as EventPackagePreview
    setEventPackagePath(folder)
    setEventPackagePreview(preview)
    setResult(null)
  }, [])

  const totalSize = previewFiles.reduce((sum, f) => sum + f.size, 0)
  const selectedCount = selectedPaths.size

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={importKind === 'event' ? '导入事件' : '导入照片'}
      className="max-w-2xl"
      closeOnOverlayClick={false}
    >
      <div className="space-y-4">
        <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700 pb-3">
          {(['photos', 'event'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setImportKind(kind)}
              className={cn(
                'px-3 py-1.5 text-xs rounded-lg border transition-colors',
                importKind === kind
                  ? 'bg-[#007AFF] text-white border-[#007AFF]'
                  : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300'
              )}
            >
              {kind === 'photos' ? '导入照片' : '导入事件'}
            </button>
          ))}
        </div>

        {importKind === 'event' && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              选择包含 event.json 的 PhotoPeek 事件文件夹，程序会自动恢复照片、标签和全部版本。
            </p>
            <div className="flex gap-2">
              <input
                value={eventPackagePath}
                readOnly
                placeholder="尚未选择事件文件夹"
                className="flex-1 px-3 py-2 text-xs bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-500"
              />
              <Button variant="default" size="sm" onClick={handleSelectEventPackage}>
                <FolderOpen size={14} />
                选择
              </Button>
            </div>
            {eventPackagePreview && (
              <div
                className={cn(
                  'rounded-lg p-3 text-xs',
                  eventPackagePreview.valid
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-300'
                )}
              >
                {eventPackagePreview.valid ? (
                  <>
                    <div className="font-medium">✓ {eventPackagePreview.eventName}</div>
                    <div className="mt-1">
                      照片 {eventPackagePreview.photoCount} 张，版本{' '}
                      {eventPackagePreview.versionCount} 个
                    </div>
                    {eventPackagePreview.missingFiles.length > 0 && (
                      <div className="mt-1 text-yellow-600">
                        缺少文件 {eventPackagePreview.missingFiles.length} 个，导入时将跳过
                      </div>
                    )}
                  </>
                ) : (
                  <div>✕ {eventPackagePreview.error || '事件包无效'}</div>
                )}
              </div>
            )}
            {importing && progress && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span>{progress.message}</span>
                  <span>
                    {progress.current}/{progress.total}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#007AFF]"
                    style={{ width: `${Math.max(progress.percent, 2)}%` }}
                  />
                </div>
              </div>
            )}
            {result && (
              <div className="text-xs text-green-600">
                已导入 {result.imported} 张照片
                {result.errors.length > 0 ? `，${result.errors.length} 项异常` : ''}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="default" onClick={handleClose}>
                {result ? '完成' : '取消'}
              </Button>
              <Button
                variant="primary"
                onClick={handleStartImport}
                disabled={importing || !eventPackagePreview?.valid}
              >
                {importing ? '导入中...' : '导入事件'}
              </Button>
            </div>
          </div>
        )}

        {importKind === 'photos' && (
          <div className="space-y-4">
            {/* Target event selector with inline creation */}
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                导入到事件
              </label>

              {/* New event input (non-controlled, CSS toggle) */}
              <div style={{ display: showNewEventInput ? 'flex' : 'none' }} className="gap-2">
                <input
                  type="text"
                  ref={newEventInputRef}
                  defaultValue=""
                  placeholder="输入事件名称..."
                  className="flex-1 px-3 py-2 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF]"
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') handleCreateEvent()
                    if (e.key === 'Escape') {
                      setShowNewEventInput(false)
                      if (newEventInputRef.current) newEventInputRef.current.value = ''
                    }
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCreateEvent}
                  disabled={creatingEvent}
                >
                  {creatingEvent ? '...' : '创建'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowNewEventInput(false)
                    if (newEventInputRef.current) newEventInputRef.current.value = ''
                  }}
                >
                  取消
                </Button>
              </div>

              {/* Event selector (CSS toggle) */}
              <div style={{ display: showNewEventInput ? 'none' : 'flex' }} className="gap-2">
                <select
                  value={targetEventId}
                  onChange={(e) => setTargetEventId(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF]"
                >
                  <option value="">选择事件...</option>
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name} ({ev.photoCount})
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    setShowNewEventInput(true)
                    setTimeout(() => newEventInputRef.current?.focus(), 50)
                  }}
                  className="px-3 py-2 border border-dashed border-gray-300 dark:border-gray-600 rounded-lg hover:border-[#007AFF] hover:text-[#007AFF] text-gray-400 transition-colors"
                  title="新建事件"
                >
                  <Plus size={18} />
                </button>
              </div>
            </div>

            {/* Import mode selector */}
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                导入类型
              </label>
              <div className="flex gap-3">
                <label
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors flex-1',
                    importMode === 'original'
                      ? 'border-[#007AFF] bg-blue-50 dark:bg-blue-900/20 text-[#007AFF]'
                      : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-400'
                  )}
                >
                  <input
                    type="radio"
                    name="importMode"
                    value="original"
                    checked={importMode === 'original'}
                    onChange={() => setImportMode('original')}
                    className="accent-[#007AFF]"
                  />
                  <div>
                    <div className="text-sm font-medium">原图</div>
                    <div className="text-xs opacity-70">JPEG / RAW / HEIC</div>
                  </div>
                </label>
                <label
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors flex-1',
                    importMode === 'retouched'
                      ? 'border-[#007AFF] bg-blue-50 dark:bg-blue-900/20 text-[#007AFF]'
                      : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-400'
                  )}
                >
                  <input
                    type="radio"
                    name="importMode"
                    value="retouched"
                    checked={importMode === 'retouched'}
                    onChange={() => setImportMode('retouched')}
                    className="accent-[#007AFF]"
                  />
                  <div>
                    <div className="text-sm font-medium">
                      <Edit3 size={12} className="inline mr-0.5" />
                      修图版本
                    </div>
                    <div className="text-xs opacity-70">以「{versionName || '昵称'}」导入</div>
                  </div>
                </label>
              </div>
            </div>

            {/* Drop zone / source selector */}
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-6 text-center hover:border-[#007AFF] transition-colors cursor-pointer"
              onClick={previewFiles.length === 0 ? handleSelectFolder : undefined}
            >
              <Upload className="mx-auto mb-2 text-gray-400" size={24} />
              <div className="text-sm text-gray-500 dark:text-gray-400">拖拽文件夹或照片到此处</div>
              <div className="flex items-center justify-center gap-2 mt-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleSelectFolder()
                  }}
                  className="px-3 py-1.5 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors flex items-center gap-1"
                >
                  <FolderOpen size={14} /> 选择文件夹
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleSelectFiles()
                  }}
                  className="px-3 py-1.5 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors flex items-center gap-1"
                >
                  <File size={14} /> 选择文件
                </button>
                {previewFiles.length > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setPreviewFiles([])
                      setSelectedPaths(new Set())
                      setResult(null)
                    }}
                    className="px-3 py-1.5 text-xs rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    清空列表
                  </button>
                )}
              </div>
            </div>

            {/* Preview grid */}
            {previewFiles.length > 0 && !importing && !result && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <FileImage size={16} />
                    <span>
                      共 {previewFiles.length} 个，已选 {selectedCount} 个
                    </span>
                    <span className="text-xs text-gray-400">({formatSize(totalSize)})</span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={selectAll} className="text-xs text-[#007AFF] hover:underline">
                      全选
                    </button>
                    <button onClick={deselectAll} className="text-xs text-gray-400 hover:underline">
                      取消
                    </button>
                    <button
                      onClick={() => {
                        setPreviewFiles([])
                        setSelectedPaths(new Set())
                        setResult(null)
                      }}
                      className="text-xs text-red-500 hover:underline"
                    >
                      清空
                    </button>
                  </div>
                </div>

                <div className="max-h-60 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
                  {previewFiles.map((file) => (
                    <label
                      key={file.path}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors',
                        selectedPaths.has(file.path) ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selectedPaths.has(file.path)}
                        onChange={() => toggleFile(file.path)}
                        className="accent-[#007AFF]"
                      />
                      <div className="w-8 h-8 rounded overflow-hidden bg-gray-200 dark:bg-gray-700 shrink-0 relative">
                        <img
                          src={`photo:///${file.path.replace(/\\/g, '/')}`}
                          alt={file.name}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            const el = e.target as HTMLImageElement
                            el.style.display = 'none'
                            const fb = el.nextElementSibling as HTMLElement
                            if (fb) fb.style.display = 'flex'
                          }}
                        />
                        <span className="absolute inset-0 hidden items-center justify-center text-[10px] text-gray-500">
                          {file.ext.slice(1).toUpperCase().slice(0, 3)}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate text-gray-800 dark:text-gray-200">
                          {file.name}
                        </div>
                        <div className="text-xs text-gray-400">{formatSize(file.size)}</div>
                      </div>
                      {selectedPaths.has(file.path) && (
                        <CheckCircle2 size={16} className="text-[#34C759] shrink-0" />
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Import progress */}
            {importing && progress && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                  <div className="animate-spin w-4 h-4 border-2 border-[#007AFF] border-t-transparent rounded-full" />
                  <span>{progress.message}</span>
                  <span className="ml-auto text-xs text-gray-400">
                    {progress.current}/{progress.total}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#007AFF] rounded-full transition-all duration-300"
                    style={{ width: `${Math.max(progress.percent, 2)}%` }}
                  />
                </div>
              </div>
            )}

            {/* Result */}
            {result && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-2">
                {result.totalError ? (
                  <div className="flex items-center gap-2 text-red-500">
                    <XCircle size={18} />
                    <span className="text-sm font-medium">导入失败：{result.totalError}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-green-600">
                      <CheckCircle2 size={18} />
                      <span className="text-sm font-medium">✓ 共导入 {result.imported} 张</span>
                    </div>
                    {(result.merged ?? 0) > 0 && (
                      <div className="flex items-center gap-2 text-blue-600 ml-6">
                        <Link2 size={14} />
                        <span className="text-xs">其中 {result.merged} 张匹配到已有版本</span>
                      </div>
                    )}
                    {result.skipped > 0 && (
                      <div className="flex items-center gap-2 text-yellow-600">
                        <AlertCircle size={18} />
                        <span className="text-sm">跳过 {result.skipped} 张重复</span>
                      </div>
                    )}
                    {result.errors.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 text-red-500 mb-1">
                          <XCircle size={18} />
                          <span className="text-sm">{result.errors.length} 个文件导入失败</span>
                        </div>
                        {result.errorDetails && result.errorDetails.length > 0 && (
                          <div className="max-h-32 overflow-y-auto mt-1 space-y-0.5">
                            {result.errorDetails.map((detail, i) => (
                              <div
                                key={i}
                                className="text-xs text-red-400 ml-6 font-mono truncate"
                                title={detail}
                              >
                                {detail}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              {importing ? (
                <Button variant="default" onClick={handleClose} disabled={cancelling}>
                  {cancelling ? '正在取消...' : '取消导入'}
                </Button>
              ) : (
                <>
                  <Button variant="default" onClick={handleClose}>
                    {result ? '完成' : '取消'}
                  </Button>
                  {previewFiles.length > 0 && !importing && !result && (
                    <Button
                      variant="primary"
                      onClick={handleStartImport}
                      disabled={!targetEventId || selectedCount === 0}
                    >
                      导入 {selectedCount > 0 ? `(${selectedCount} 张)` : ''}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

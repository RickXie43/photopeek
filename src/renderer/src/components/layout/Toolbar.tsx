import React from 'react'
import { Grid3X3, ZoomIn, Columns3, Settings, Trash2, Share2, ArrowUpDown } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { usePhotoStore } from '../../stores/photoStore'
import { cn } from '../../lib/cn'
import { ShareDialog } from '../ui/ShareDialog'
import type { SortBy } from '../../types/photo'

export function Toolbar(): React.JSX.Element {
  const {
    keyboardMode,
    setKeyboardMode,
    thumbnailSize,
    setThumbnailSize,
    toggleInspector,
    inspectorVisible,
    setImportDialogOpen,
    setCreateEventDialogOpen,
    setSettingsDialogOpen,
    sortBy,
    setSortBy,
  } = useUIStore()

  const { selectedPhotoIds, removePhotos } = usePhotoStore()
  const selectedCount = selectedPhotoIds.size
  const [showShare, setShowShare] = React.useState(false)

  const handleBatchDelete = async (): Promise<void> => {
    const ids = Array.from(selectedPhotoIds)
    if (ids.length === 0) return

    const confirmed = window.confirm(`确定要删除选中的 ${ids.length} 张照片吗？\n\n照片文件和缩略图将被永久删除，此操作不可撤销！`)
    if (!confirmed) return

    try {
      const result = await window.electron.ipcRenderer.invoke('photos:delete', ids) as { success: boolean; deleted: number }
      if (result.success) {
        removePhotos(ids)
      }
    } catch (err) {
      console.error('Failed to batch delete photos:', err)
    }
  }

  return (
    <header className="h-12 border-b border-[var(--color-border)] flex items-center px-4 justify-between shrink-0 bg-[var(--color-background)]">
      {/* Left */}
      <div className="flex items-center gap-2">
        <Grid3X3 size={16} className="text-gray-500" />
        <span className="text-xs text-gray-500 font-medium">网格</span>

        <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />

        {/* Thumbnail size slider */}
        <div className="flex items-center gap-1.5">
          <ZoomIn size={14} className="text-gray-400" />
          <input
            type="range"
            min={80}
            max={400}
            value={thumbnailSize}
            onChange={(e) => setThumbnailSize(Number(e.target.value))}
            className="w-16 h-1 accent-[#007AFF] cursor-pointer"
          />
        </div>

        <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />

        {/* Sort control */}
        <div className="flex items-center gap-1">
          <ArrowUpDown size={14} className="text-gray-400" />
          {(['created_at', 'file_name'] as SortBy[]).map((key) => (
            <button
              key={key}
              onClick={() => {
                setSortBy(key)
                window.dispatchEvent(new CustomEvent('refresh-photos'))
              }}
              className={cn(
                'px-2 py-1 text-xs font-medium rounded-md transition-colors',
                sortBy === key
                  ? 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200'
                  : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
              )}
            >
              {key === 'created_at' ? '时间' : '文件名'}
            </button>
          ))}
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1.5">
        {/* Keyboard mode switcher */}
        <button
          onClick={() => setKeyboardMode(keyboardMode === 'vim' ? 'macos' : 'vim')}
          className={cn(
            'px-2 py-1 text-xs font-mono rounded-md transition-colors',
            keyboardMode === 'vim'
              ? 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200'
              : 'text-gray-400 hover:text-gray-600'
          )}
          title="切换快捷键模式"
        >
          {keyboardMode === 'vim' ? 'VIM' : '⌘'}
        </button>

        <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />

        <button
          onClick={() => setShowShare(true)}
          className="px-2.5 py-1 text-xs font-medium bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-1"
          title="共享事件"
        >
          <Share2 size={13} />
          共享
        </button>

        <button
          onClick={() => setImportDialogOpen(true)}
          className="px-3 py-1 text-xs font-medium bg-[#007AFF] text-white rounded-lg hover:bg-[#0066CC] transition-colors"
        >
          导入
        </button>

        <button
          onClick={() => setCreateEventDialogOpen(true)}
          className="px-3 py-1 text-xs font-medium bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          + 事件
        </button>

        {/* Batch delete (visible when photos selected) */}
        {selectedCount > 0 && (
          <>
            <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />
            <span className="text-xs text-gray-500">{selectedCount} 张已选</span>
            <button
              onClick={handleBatchDelete}
              className="px-2.5 py-1 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors flex items-center gap-1"
              title="删除选中照片"
            >
              <Trash2 size={13} />
              删除
            </button>
          </>
        )}

        <div className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" />

        {/* Inspector toggle */}
        <button
          onClick={setSettingsDialogOpen ? () => setSettingsDialogOpen(true) : undefined}
          className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 transition-colors"
          title="设置"
        >
          <Settings size={16} />
        </button>

        <button
          onClick={toggleInspector}
          className={cn(
            'p-1.5 rounded-lg transition-colors',
            inspectorVisible
              ? 'bg-gray-200 dark:bg-gray-700 text-gray-600'
              : 'text-gray-400 hover:text-gray-600'
          )}
          title="切换信息面板"
        >
          <Columns3 size={16} />
        </button>
      </div>

      <ShareDialog open={showShare} onClose={() => setShowShare(false)} />
    </header>
  )
}

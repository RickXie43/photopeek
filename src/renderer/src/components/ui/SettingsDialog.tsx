import React, { useState, useEffect } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { useUIStore } from '../../stores/uiStore'
import { FolderOpen, Keyboard, Image, Info, Trash2 } from 'lucide-react'

interface SettingsData {
  libraryPath: string
  keyboardMode: 'vim' | 'macos' | 'custom'
  thumbnailSize: number
  language: string
  nickname: string
}

export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { setKeyboardMode, setThumbnailSize } = useUIStore()
  const [settings, setSettings] = useState<SettingsData>({
    libraryPath: '',
    keyboardMode: 'vim',
    thumbnailSize: 200,
    language: 'zh-CN',
    nickname: '',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      loadSettings()
    }
  }, [open])

  const loadSettings = async (): Promise<void> => {
    try {
      const config = (await window.electron.ipcRenderer.invoke('settings:get')) as SettingsData
      const libPath = (await window.electron.ipcRenderer.invoke('settings:getLibraryPath')) as string
      setSettings({
        ...config,
        libraryPath: libPath,
      })
    } catch (err) {
      console.error('Failed to load settings:', err)
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.electron.ipcRenderer.invoke('settings:update', {
        keyboardMode: settings.keyboardMode,
        thumbnailSize: settings.thumbnailSize,
        language: settings.language,
      })
      if (settings.libraryPath) {
        await window.electron.ipcRenderer.invoke('settings:setLibraryPath', settings.libraryPath)
      }
      if (settings.nickname) {
        await window.electron.ipcRenderer.invoke('settings:update', { nickname: settings.nickname } as any)
      }
      setKeyboardMode(settings.keyboardMode)
      setThumbnailSize(settings.thumbnailSize)
      onClose()
    } catch (err) {
      console.error('Failed to save settings:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleSelectLibraryFolder = async (): Promise<void> => {
    try {
      const folder = await window.electron.ipcRenderer.invoke('import:selectFolder')
      if (folder) {
        setSettings((s) => ({ ...s, libraryPath: (folder as string) || '' }))
      }
    } catch (err) {
      console.error('Failed to select folder:', err)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="设置" className="max-w-lg">
      <div className="space-y-6">
        {/* Library Path */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <FolderOpen size={16} className="text-gray-500" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">照片库位置</span>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={settings.libraryPath}
              onChange={(e) => setSettings((s) => ({ ...s, libraryPath: e.target.value }))}
              className="flex-1 px-3 py-1.5 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF]"
            />
            <Button variant="default" size="sm" onClick={handleSelectLibraryFolder}>
              浏览...
            </Button>
          </div>
          <div className="text-xs text-gray-400 mt-1">
            照片将复制到此目录中的 events/ 文件夹下
          </div>
        </section>

        <div className="h-px bg-gray-200 dark:bg-gray-700" />

        {/* Keyboard Mode */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Keyboard size={16} className="text-gray-500" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">快捷键模式</span>
          </div>
          <div className="flex gap-2">
            {(['vim', 'macos', 'custom'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setSettings((s) => ({ ...s, keyboardMode: mode }))}
                className={`px-4 py-1.5 text-sm rounded-lg border transition-colors ${
                  settings.keyboardMode === mode
                    ? 'bg-[#007AFF] text-white border-[#007AFF]'
                    : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-gray-400'
                }`}
              >
                {mode === 'vim' ? 'Vim 风格' : mode === 'macos' ? 'macOS 风格' : '自定义'}
              </button>
            ))}
          </div>
        </section>

        <div className="h-px bg-gray-200 dark:bg-gray-700" />

        {/* Thumbnail Size */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Image size={16} className="text-gray-500" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">缩略图大小</span>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={80}
              max={400}
              value={settings.thumbnailSize}
              onChange={(e) => setSettings((s) => ({ ...s, thumbnailSize: Number(e.target.value) }))}
              className="flex-1 h-1 accent-[#007AFF]"
            />
            <span className="text-xs text-gray-500 w-8 text-right">{settings.thumbnailSize}px</span>
          </div>
        </section>

        <div className="h-px bg-gray-200 dark:bg-gray-700" />

        {/* Nickname */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm">👤</span>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">昵称</span>
          </div>
          <input
            type="text"
            value={settings.nickname}
            onChange={(e) => setSettings((s) => ({ ...s, nickname: e.target.value }))}
            placeholder="你的昵称（用作默认标签名）"
            className="w-full px-3 py-1.5 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF]"
          />
          <div className="text-xs text-gray-400 mt-1">
            在放大模式下按空格键使用此昵称作为标签
          </div>
        </section>

        <div className="h-px bg-gray-200 dark:bg-gray-700" />

        {/* Cache Management */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Trash2 size={16} className="text-gray-500" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">缓存管理</span>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            清除所有缓存数据（包括数据库、缩略图和已导入的照片），应用将恢复初始状态。
          </p>
          <CacheClearButton />
        </section>

        <div className="h-px bg-gray-200 dark:bg-gray-700" />

        {/* About */}
        <section>
          <div className="flex items-center gap-2 mb-1">
            <Info size={16} className="text-gray-500" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">关于</span>
          </div>
          <div className="text-xs text-gray-400 space-y-0.5">
            <div>PhotoPeek v1.0.0</div>
            <div>Electron + React + TypeScript</div>
          </div>
        </section>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="default" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function CacheClearButton(): React.JSX.Element {
  const [clearing, setClearing] = useState(false)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const handleClear = async (): Promise<void> => {
    const confirmed = window.confirm(
      '确定要清除所有缓存吗？\n\n这将删除：\n• 所有事件和照片数据\n• 所有缩略图\n• 已导入的照片文件\n\n应用将重新初始化，此操作不可撤销！'
    )
    if (!confirmed) return

    setClearing(true)
    setStatus('idle')
    setMessage('')

    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'cache:clear'
      )) as { success: boolean; error?: string }

      if (result.success) {
        setStatus('success')
        setMessage('缓存已清除，正在重新加载...')
        // Reload the app after a short delay
        setTimeout(() => {
          window.location.reload()
        }, 1500)
      } else {
        setStatus('error')
        setMessage(result.error || '清除失败，请重试')
      }
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : '清除缓存时发生错误')
      console.error('Cache clear error:', err)
    } finally {
      setClearing(false)
    }
  }

  return (
    <div>
      <Button
        variant="danger"
        size="sm"
        onClick={handleClear}
        disabled={clearing}
        className="flex items-center gap-1"
      >
        {clearing ? (
          <>
            <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            清除中...
          </>
        ) : (
          <>
            <Trash2 size={14} />
            清除所有缓存
          </>
        )}
      </Button>
      {status === 'success' && (
        <div className="text-xs text-green-600 mt-1">{message}</div>
      )}
      {status === 'error' && (
        <div className="text-xs text-red-500 mt-1">{message}</div>
      )}
    </div>
  )
}

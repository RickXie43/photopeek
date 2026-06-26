import React, { useState, useEffect } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { FolderOpen, Info, Trash2 } from 'lucide-react'
import { confirm } from '../ui/ConfirmDialog'

interface SettingsData {
  libraryPath: string
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
  const [settings, setSettings] = useState<SettingsData>({
    libraryPath: '',
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
        language: settings.language,
      })
      if (settings.libraryPath) {
        await window.electron.ipcRenderer.invoke('settings:setLibraryPath', settings.libraryPath)
      }
      if (settings.nickname) {
        await window.electron.ipcRenderer.invoke('settings:update', { nickname: settings.nickname } as any)
      }
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
          <div className="space-y-3">
            <div>
              <p className="text-xs text-gray-400 mb-2">
                清除所有数据（包括数据库、缩略图、缓存和已导入的照片），应用将恢复初始状态。
              </p>
              <CacheClearAllButton />
            </div>
          </div>
        </section>

        <div className="h-px bg-gray-200 dark:bg-gray-700" />

        {/* About */}
        <section>
          <div className="flex items-center gap-2 mb-1">
            <Info size={16} className="text-gray-500" />
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">关于</span>
          </div>
          <div className="text-xs text-gray-400 space-y-0.5">
            <div>PhotoPeek v2.0.1</div>
            <div>Electron + React + TypeScript</div>
          </div>
          <UpdateChecker />
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

function CacheClearAllButton(): React.JSX.Element {
  const [clearing, setClearing] = useState(false)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const handleClear = async (): Promise<void> => {
    const confirmed = await confirm({
      title: '清除所有数据',
      message: '确定要清除所有数据和设置吗？\n\n这将删除：\n• 所有事件和照片数据\n• 所有缩略图和缓存\n• 已导入的照片文件\n• 所有设置\n\n清除后将重启软件，此操作不可撤销！',
      confirmText: '清除并重启',
      cancelText: '取消',
      variant: 'danger',
    })
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
        setMessage('已清除所有数据，正在重启...')
        setTimeout(() => {
          window.electron.ipcRenderer.invoke('app:restart')
        }, 1000)
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
            清除所有数据和设置
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

function UpdateChecker(): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [result, setResult] = useState<{ message: string; isError: boolean } | null>(null)

  const handleCheck = async (): Promise<void> => {
    setChecking(true)
    setResult(null)
    try {
      const res = (await window.electron.ipcRenderer.invoke(
        'updates:checkLatest'
      )) as {
        latestVersion: string
        downloadUrl: string
        hasUpdate: boolean
        error?: string
      }
      if (res.error) {
        setResult({ message: `检查失败: ${res.error}`, isError: true })
      } else if (res.hasUpdate && res.latestVersion) {
        const confirmUpdate = window.confirm(
          `发现新版本 ${res.latestVersion}，是否立即下载并安装？`
        )
        if (confirmUpdate) {
          setDownloading(true)
          setResult({ message: '正在下载更新...', isError: false })
          const result = (await window.electron.ipcRenderer.invoke(
            'updates:downloadAndInstall',
            res.downloadUrl || ''
          )) as { success: boolean; error?: string }
          if (result.success) {
            setResult({ message: '下载完成，正在安装...', isError: false })
          } else {
            setDownloading(false)
            setResult({ message: `更新失败: ${result.error}`, isError: true })
          }
        } else {
          setResult(null)
        }
      } else if (res.latestVersion) {
        setResult({ message: `已是最新版本 (${res.latestVersion})`, isError: false })
      } else {
        setResult({ message: '无法获取版本信息', isError: true })
      }
    } catch (err: any) {
      setResult({ message: `检查失败: ${err.message}`, isError: true })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="mt-2">
      <button
        onClick={handleCheck}
        disabled={checking || downloading}
        className="text-xs text-[#007AFF] hover:text-[#0056CC] disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
      >
        {downloading ? '下载中...' : checking ? '检查中...' : '检查更新'}
      </button>
      {result && (
        <div
          className={`text-xs mt-1 ${result.isError ? 'text-red-400' : 'text-green-500'}`}
        >
          {result.message}
        </div>
      )}
    </div>
  )
}

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { useEventStore } from '../../stores/eventStore'

interface CreateEventDialogProps {
  open: boolean
  onClose: () => void
}

export function CreateEventDialog({
  open,
  onClose,
}: CreateEventDialogProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const { addEvent } = useEventStore()
  const inputRef = useRef<HTMLInputElement>(null)

  // Robust focus mechanism: retry multiple times with increasing delays
  useEffect(() => {
    if (!open) return

    let cancelled = false
    const attempts = [0, 50, 150, 400]

    const tryFocus = (): void => {
      if (cancelled) return
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    }

    // First attempt in the same microtask
    tryFocus()

    // Then retry with delays to overcome any stray focus-stealing
    const timers = attempts.map((delay) => setTimeout(tryFocus, delay))

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [open])

  // Also focus when the user clicks anywhere inside the dialog
  const handleDialogClick = useCallback((e: React.MouseEvent): void => {
    // Only focus if the click is not on a button
    const target = e.target as HTMLElement
    if (target.tagName !== 'BUTTON' && !target.closest('button')) {
      inputRef.current?.focus()
    }
  }, [])

  const handleCreate = async (): Promise<void> => {
    if (!name.trim()) return
    setLoading(true)
    try {
      const result = await window.electron.ipcRenderer.invoke('events:create', {
        name: name.trim(),
        description: description.trim(),
      })
      addEvent(result as any)
      setName('')
      setDescription('')
      onClose()
    } catch (err) {
      console.error('Failed to create event:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="新建事件">
      <div className="space-y-4" onClick={handleDialogClick}>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            事件名称
          </label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：2025 日本旅行"
            className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF] focus:border-transparent"
            autoFocus
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') handleCreate()
            }}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            描述（可选）
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="添加描述..."
            rows={3}
            className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF] focus:border-transparent resize-none"
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={!name.trim() || loading}
          >
            {loading ? '创建中...' : '创建'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

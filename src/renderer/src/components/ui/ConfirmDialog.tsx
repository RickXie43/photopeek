import React, { useState, useCallback, useRef, useEffect } from 'react'
import { cn } from '../../lib/cn'
import { AlertTriangle, X } from 'lucide-react'

type ConfirmOptions = {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  variant?: 'danger' | 'default'
}

type ConfirmResolver = (value: boolean) => void

let globalResolveRef: { current: ConfirmResolver | null } = { current: null }
let globalOptionsRef: { current: ConfirmOptions | null } = { current: null }
let globalOnOpenRef: { current: (() => void) | null } = { current: null }

/**
 * 异步确认对话框函数。
 * 替代 window.confirm()，避免浏览器原生对话框导致的焦点管理问题。
 *
 * 使用方法：
 *   const confirmed = await confirm({ title: '确认删除', message: '确定要删除吗？' })
 *   if (confirmed) { ... }
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    globalOptionsRef.current = options
    globalResolveRef.current = resolve
    globalOnOpenRef.current?.()
  })
}

/**
 * ConfirmDialog 组件 — 挂在 App 根级别，通过 confirm() 函数调用。
 */
export function ConfirmDialog(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [loading, setLoading] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  // Register the open handler so confirm() can trigger it
  useEffect(() => {
    globalOnOpenRef.current = () => {
      const opts = globalOptionsRef.current
      if (opts) {
        setOptions(opts)
        setOpen(true)
        setLoading(false)
      }
    }
    return () => {
      globalOnOpenRef.current = null
    }
  }, [])

  // Auto-focus the confirm button when dialog opens
  useEffect(() => {
    if (open) {
      // Use requestAnimationFrame to ensure DOM is painted
      requestAnimationFrame(() => {
        confirmBtnRef.current?.focus()
      })
    }
  }, [open])

  const handleConfirm = useCallback((): void => {
    setLoading(true)
    globalResolveRef.current?.(true)
    setOpen(false)
    setOptions(null)
    globalResolveRef.current = null
    globalOptionsRef.current = null
  }, [])

  const handleCancel = useCallback((): void => {
    globalResolveRef.current?.(false)
    setOpen(false)
    setOptions(null)
    globalResolveRef.current = null
    globalOptionsRef.current = null
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleCancel()
      }
    },
    [handleCancel]
  )

  if (!open || !options) return null

  const isDanger = options.variant === 'danger' || options.message.includes('删除')

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === overlayRef.current) handleCancel()
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className={cn(
          'bg-white dark:bg-gray-800 rounded-2xl shadow-2xl no-drag',
          'w-full max-w-sm mx-4 overflow-hidden'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            {isDanger && (
              <AlertTriangle size={18} className="text-red-500 shrink-0" />
            )}
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {options.title}
            </h2>
          </div>
          <button
            onClick={handleCancel}
            className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4">
          <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap">
            {options.message}
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 px-5 pb-4">
          <button
            onClick={handleCancel}
            disabled={loading}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-lg transition-colors',
              'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200',
              'hover:bg-gray-200 dark:hover:bg-gray-600',
              'disabled:opacity-50'
            )}
          >
            {options.cancelText || '取消'}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={handleConfirm}
            disabled={loading}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-lg transition-colors',
              isDanger
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-[#007AFF] text-white hover:bg-[#0066CC]',
              'disabled:opacity-50'
            )}
          >
            {loading ? '处理中...' : options.confirmText || '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}

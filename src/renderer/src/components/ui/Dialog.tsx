import React, { useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  className?: string
  closeOnOverlayClick?: boolean
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
  closeOnOverlayClick = true,
}: DialogProps): React.JSX.Element | null {
  const overlayRef = useRef<HTMLDivElement>(null)

  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (closeOnOverlayClick && e.target === overlayRef.current) onClose()
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className={cn(
          'bg-white dark:bg-gray-800 rounded-2xl shadow-2xl no-drag',
          'w-full max-w-md mx-4 overflow-hidden',
          className
        )}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X size={18} className="text-gray-500" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto max-h-[75vh]">{children}</div>
      </div>
    </div>
  )
}

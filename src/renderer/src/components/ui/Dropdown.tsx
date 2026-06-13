import React, { useState } from 'react'
import { cn } from '../../lib/cn'

interface DropdownProps {
  items: { label: string; value: string; color?: string }[]
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
  className?: string
}

export function SegmentedControl({
  items,
  value,
  onChange,
  className,
}: {
  items: { label: string; value: string }[]
  value: string
  onChange: (value: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'inline-flex bg-gray-200 dark:bg-gray-700 rounded-lg p-0.5 gap-0.5',
        className
      )}
    >
      {items.map((item) => (
        <button
          key={item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            'px-3 py-1 text-xs font-medium rounded-md transition-all duration-150',
            value === item.value
              ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function Dropdown({
  items,
  value,
  onChange,
  placeholder = 'Select...',
  className,
}: DropdownProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const selectedItem = items.find((i) => i.value === value)

  return (
    <div className={cn('relative', className)}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
      >
        <span className={selectedItem ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}>
          {selectedItem?.label || placeholder}
        </span>
        <svg
          className={cn('w-3.5 h-3.5 ml-2 transition-transform', open && 'rotate-180')}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 max-h-48 overflow-y-auto">
            {items.map((item) => (
              <button
                key={item.value}
                onClick={() => {
                  onChange?.(item.value)
                  setOpen(false)
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors',
                  value === item.value
                    ? 'text-[#007AFF] font-medium'
                    : 'text-gray-700 dark:text-gray-300'
                )}
              >
                {item.color && (
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                )}
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

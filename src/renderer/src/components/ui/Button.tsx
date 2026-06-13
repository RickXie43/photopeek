import React from 'react'
import { cn } from '../../lib/cn'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({
  className,
  variant = 'default',
  size = 'md',
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-all duration-150',
        'focus:outline-none focus:ring-2 focus:ring-[#007AFF] focus:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        // Variants
        variant === 'default' && 'bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700',
        variant === 'primary' && 'bg-[#007AFF] text-white hover:bg-[#0066CC] shadow-sm',
        variant === 'ghost' && 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
        variant === 'danger' && 'bg-[#FF3B30] text-white hover:bg-[#d62d20]',
        // Sizes
        size === 'sm' && 'px-2.5 py-1 text-xs gap-1',
        size === 'md' && 'px-3.5 py-1.5 text-sm gap-1.5',
        size === 'lg' && 'px-5 py-2 text-base gap-2',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

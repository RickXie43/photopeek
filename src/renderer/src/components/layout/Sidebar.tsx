import React, { useState, useEffect } from 'react'
import { useEventStore } from '../../stores/eventStore'
import { usePhotoStore } from '../../stores/photoStore'
import { useUIStore } from '../../stores/uiStore'
import { cn } from '../../lib/cn'
import { Trash2, Pencil, TrashIcon, Wifi, StopCircle } from 'lucide-react'

export function Sidebar(): React.JSX.Element {
  const { events, selectedEventId, setSelectedEvent, removeEvent, updateEvent } = useEventStore()
  const { setPhotos } = usePhotoStore()
  const { showingTrash, setShowingTrash, setCreateEventDialogOpen } = useUIStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [connectedUsers, setConnectedUsers] = useState<{ id: string; nickname: string; joinedAt: string }[]>([])
  const [sharingEventId, setSharingEventId] = useState('')
  const [sharingEventName, setSharingEventName] = useState('')

  // Listen for share user updates
  useEffect(() => {
    if (!window.shareApi?.onUsersUpdate) return
    const unsub = window.shareApi.onUsersUpdate((data) => {
      if (data.users.length > 0) {
        setConnectedUsers(data.users)
        setSharingEventId(data.eventId)
        const ev = events.find(e => e.id === data.eventId)
        setSharingEventName(ev?.name || '')
      } else {
        setConnectedUsers([])
        setSharingEventId('')
        setSharingEventName('')
      }
    })
    return unsub
  }, [events])

  // Also check share status on mount in case already sharing
  useEffect(() => {
    const check = async (): Promise<void> => {
      try {
        for (const ev of events) {
          const status = await window.electron.ipcRenderer.invoke('share:status', ev.id) as any
          if (status.active && status.users?.length > 0) {
            setConnectedUsers(status.users)
            setSharingEventId(ev.id)
            setSharingEventName(ev.name)
            break
          }
        }
      } catch {}
    }
    if (events.length > 0) check()
  }, [events])

  const handleStopShare = async (): Promise<void> => {
    if (!sharingEventId) return
    try {
      await window.electron.ipcRenderer.invoke('share:stop', sharingEventId)
    } catch {}
    setConnectedUsers([])
    setSharingEventId('')
    setSharingEventName('')
  }

  const handleDelete = async (eventId: string, eventName: string): Promise<void> => {
    const confirmed = window.confirm(`确定要删除事件"${eventName}"吗？\n\n该事件的所有照片将被永久删除，此操作不可撤销！`)
    if (!confirmed) return

    try {
      await window.electron.ipcRenderer.invoke('events:delete', eventId)
      removeEvent(eventId)
      if (selectedEventId === eventId) {
        setPhotos([])
      }
    } catch (err) {
      console.error('Failed to delete event:', err)
    }
  }

  const handleStartRename = (event: { id: string; name: string }): void => {
    setEditingId(event.id)
    setEditName(event.name)
  }

  const handleFinishRename = async (): Promise<void> => {
    if (!editingId || !editName.trim()) {
      setEditingId(null)
      return
    }
    try {
      const result = await window.electron.ipcRenderer.invoke('events:rename', {
        id: editingId,
        newName: editName.trim(),
      }) as { success: boolean; folderName?: string }
      if (result.success) {
        updateEvent(editingId, { name: editName.trim(), folderName: result.folderName })
      }
    } catch (err) {
      console.error('Failed to rename event:', err)
    }
    setEditingId(null)
  }

  return (
    <aside className="w-64 bg-[var(--color-sidebar)] border-r border-[var(--color-border)] flex flex-col">
      {/* Title */}
      <div className="h-12 flex items-center px-4 gap-2 shrink-0 drag-region">
        <div className="w-2.5 h-2.5 rounded-full bg-[#007AFF]" />
        <span className="font-semibold text-sm text-gray-800 dark:text-gray-100">
          PhotoPeek
        </span>
      </div>

      {/* Events section */}
      <div className="px-3 pb-1 shrink-0">
        <div className="flex items-center justify-between px-2 mb-1">
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
            事件
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-gray-400">{events.length}</span>
            <button
              onClick={() => setCreateEventDialogOpen(true)}
              className="text-[11px] font-medium text-gray-400 hover:text-[#007AFF] transition-colors leading-none"
              title="添加事件"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Event list */}
      <nav className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5">
        {events.length === 0 ? (
          <div className="px-2 py-3 text-xs text-gray-400 text-center">
            暂无事件
            <br />
            拖入照片开始创建
          </div>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className={cn(
                'group flex items-center gap-2.5 px-2 py-2 text-sm rounded-lg transition-colors',
                selectedEventId === event.id
                  ? 'bg-[#007AFF] text-white'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
              )}
            >
              {editingId === event.id ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={handleFinishRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleFinishRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className={cn(
                    'flex-1 min-w-0 px-1 py-0.5 text-sm bg-transparent border-b focus:outline-none',
                    selectedEventId === event.id
                      ? 'border-white/60 text-white'
                      : 'border-gray-400 text-gray-800 dark:text-gray-200'
                  )}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <button
                    onClick={() => {
                      setSelectedEvent(event.id)
                      setShowingTrash(false)
                    }}
                    className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                  >
                    {/* Cover thumbnail placeholder */}
                    <div className="w-8 h-8 rounded-md bg-gray-300 dark:bg-gray-600 shrink-0 flex items-center justify-center text-[10px] text-gray-500">
                      📷
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{event.name}</div>
                      <div className="text-[11px] text-gray-400 dark:text-gray-500">
                        {event.photoCount} 张照片
                      </div>
                    </div>
                  </button>

                  {/* Action buttons (visible on hover) */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleStartRename(event) }}
                      className={cn(
                        'p-1 rounded transition-colors',
                        selectedEventId === event.id
                          ? 'hover:bg-white/20 text-white/80'
                          : 'hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400'
                      )}
                      title="重命名"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(event.id, event.name) }}
                      className={cn(
                        'p-1 rounded transition-colors',
                        selectedEventId === event.id
                          ? 'hover:bg-white/20 text-white/60 hover:text-red-300'
                          : 'hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400 hover:text-red-500'
                      )}
                      title="删除事件"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </nav>

      {/* Trash */}
      <div className="shrink-0 px-3 pb-1">
        <button
          onClick={() => {
            setShowingTrash(!showingTrash)
            if (!showingTrash) {
              setSelectedEvent('__trash__')
            }
          }}
          className={cn(
            'w-full flex items-center gap-2.5 px-2 py-2 text-sm rounded-lg transition-colors',
            showingTrash
              ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
          )}
        >
          <TrashIcon size={16} />
          <span>回收站</span>
        </button>
      </div>

      {/* Bottom status */}
      <div className="shrink-0 px-4 py-2 border-t border-[var(--color-border)]">
        {connectedUsers.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs">
              <div className="w-2 h-2 rounded-full bg-[#30d158] animate-pulse" />
              <span className="font-medium text-[#30d158]">正在共享</span>
              <span className="text-gray-400">· {sharingEventName}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {connectedUsers.map((u) => (
                <span
                  key={u.id}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-[10px] text-gray-500 dark:text-gray-300"
                >
                  <Wifi size={8} />
                  {u.nickname}
                </span>
              ))}
            </div>
            <button
              onClick={handleStopShare}
              className="w-full flex items-center justify-center gap-1 px-2 py-1 mt-1 text-[10px] font-medium text-red-500 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-md transition-colors"
            >
              <StopCircle size={12} />
              终止共享
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            就绪
          </div>
        )}
      </div>
    </aside>
  )
}

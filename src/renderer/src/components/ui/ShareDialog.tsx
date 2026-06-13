import React, { useState, useEffect, useRef } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { useEventStore } from '../../stores/eventStore'
import { Share2, StopCircle, Wifi, Copy, Check, Users, Tag, Activity, Globe, GlobeOff, Loader2 } from 'lucide-react'

interface ConnectedUser {
  id: string
  nickname: string
  joinedAt: string
}

interface TagActivity {
  id: number
  nickname: string
  action: 'added' | 'removed'
  tagName: string
  timestamp: string
}

export function ShareDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { events, selectedEventId } = useEventStore()
  const [targetEventId, setTargetEventId] = useState(selectedEventId || '')
  const [sharing, setSharing] = useState(false)
  const [shareInfo, setShareInfo] = useState<{ port: number; ips: string[]; url: string } | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [connectedUsers, setConnectedUsers] = useState<ConnectedUser[]>([])
  const [tagActivities, setTagActivities] = useState<TagActivity[]>([])
  const activityIdRef = useRef(0)

  // Tunnel (public sharing) state
  const [tunnelActive, setTunnelActive] = useState(false)
  const [tunnelUrl, setTunnelUrl] = useState('')
  const [tunnelStarting, setTunnelStarting] = useState(false)
  const [tunnelError, setTunnelError] = useState('')
  const [tunnelCopied, setTunnelCopied] = useState(false)

  // Generate QR code when share info is available
  useEffect(() => {
    if (!shareInfo?.url) { setQrDataUrl(''); return }
    try {
      import('qrcode').then(mod => {
        mod.default.toDataURL(shareInfo.url, { width: 180, margin: 1 }, (err, url) => {
          if (!err) setQrDataUrl(url)
        })
      })
    } catch {}
  }, [shareInfo])

  // Listen for real-time user updates, tag actions, and tunnel status from main process
  useEffect(() => {
    if (!open || !shareInfo) return

    const unsubUsers = window.shareApi.onUsersUpdate((data) => {
      if (data.eventId === targetEventId) {
        setConnectedUsers(data.users)
      }
    })

    const unsubTags = window.shareApi.onTagAction((data) => {
      if (data.eventId === targetEventId) {
        const id = ++activityIdRef.current
        setTagActivities(prev => [{ id, nickname: data.nickname, action: data.action, tagName: data.tagName, timestamp: data.timestamp }, ...prev].slice(0, 50))
      }
    })

    const unsubTunnel = window.shareApi.onTunnelStatus((data) => {
      if (data.eventId === targetEventId) {
        setTunnelActive(data.active)
        setTunnelUrl(data.url || '')
        if (data.active) setTunnelStarting(false)
      }
    })

    return () => {
      unsubUsers()
      unsubTags()
      unsubTunnel()
    }
  }, [open, shareInfo, targetEventId])

  const handleStartShare = async (): Promise<void> => {
    if (!targetEventId) return
    setSharing(true)
    setError('')
    setShareInfo(null)
    setConnectedUsers([])
    setTagActivities([])
    try {
      const result = await window.electron.ipcRenderer.invoke('share:start', {
        eventId: targetEventId,
      }) as { success: boolean; port: number; ips: string[]; url: string; error?: string }
      if (result.success) {
        setShareInfo({ port: result.port, ips: result.ips, url: result.url })
        // Also query current listeners
        const users = await window.electron.ipcRenderer.invoke('share:listeners', targetEventId) as ConnectedUser[]
        setConnectedUsers(users)
      } else {
        setError(result.error || '共享启动失败')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setSharing(false)
    }
  }

  const handleStopShare = async (): Promise<void> => {
    if (!targetEventId) return
    try {
      await window.electron.ipcRenderer.invoke('share:stop', targetEventId)
    } catch {}
    setShareInfo(null)
    setQrDataUrl('')
    setConnectedUsers([])
    setTagActivities([])
    setTunnelActive(false)
    setTunnelUrl('')
    setTunnelError('')
  }

  const handleCopy = (): void => {
    if (!shareInfo?.url) return
    navigator.clipboard.writeText(shareInfo.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleTunnelStart = async (): Promise<void> => {
    if (!targetEventId) return
    setTunnelStarting(true)
    setTunnelError('')
    try {
      const result = await window.electron.ipcRenderer.invoke('share:tunnelStart', targetEventId) as { success: boolean; url?: string; error?: string }
      if (result.success) {
        setTunnelActive(true)
        setTunnelUrl(result.url || '')
      } else {
        setTunnelError(result.error || '公网隧道启动失败')
      }
    } catch (err) {
      setTunnelError(String(err))
    } finally {
      setTunnelStarting(false)
    }
  }

  const handleTunnelStop = async (): Promise<void> => {
    if (!targetEventId) return
    try {
      await window.electron.ipcRenderer.invoke('share:tunnelStop', targetEventId)
    } catch {}
    setTunnelActive(false)
    setTunnelUrl('')
    setTunnelError('')
  }

  const handleTunnelCopy = (): void => {
    if (!tunnelUrl) return
    navigator.clipboard.writeText(tunnelUrl).then(() => {
      setTunnelCopied(true)
      setTimeout(() => setTunnelCopied(false), 2000)
    })
  }

  // Load share status when opening
  useEffect(() => {
    if (!open) return
    const load = async (): Promise<void> => {
      if (!targetEventId) return
      try {
        const status = await window.electron.ipcRenderer.invoke('share:status', targetEventId) as any
        if (status.active) {
          setShareInfo({ port: status.port, ips: status.ips, url: status.url })
          setConnectedUsers(status.users || [])
          // Restore tunnel state
          if (status.tunnel?.active) {
            setTunnelActive(true)
            setTunnelUrl(status.tunnel.url || '')
          }
        }
      } catch {}
    }
    load()
  }, [open, targetEventId])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setTagActivities([])
      setConnectedUsers([])
      setTunnelError('')
    }
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} title="共享事件" className="max-w-lg">
      <div className="space-y-4">
        {/* Event selector */}
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            选择要共享的事件
          </label>
          <select
            value={targetEventId}
            onChange={(e) => setTargetEventId(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#007AFF]"
          >
            <option value="">选择事件...</option>
            {events.filter(e => e.photoCount > 0).map((ev) => (
              <option key={ev.id} value={ev.id}>{ev.name} ({ev.photoCount} 张)</option>
            ))}
          </select>
        </div>

        {/* Error */}
        {error && (
          <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">{error}</div>
        )}

        {/* Share info */}
        {shareInfo ? (
          <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
              <Wifi size={18} />
              <span className="text-sm font-medium">正在共享</span>
            </div>

            {/* Connection info */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">访问地址</span>
                <button
                  onClick={handleCopy}
                  className="text-xs text-[#007AFF] hover:underline flex items-center gap-1"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <div className="bg-white dark:bg-gray-800 px-3 py-2 rounded text-xs font-mono truncate">
                {shareInfo.url}
              </div>
            </div>

            {/* Local IPs */}
            <div>
              <span className="text-xs text-gray-500">局域网 IP</span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {shareInfo.ips.map(ip => (
                  <span key={ip} className="px-2 py-1 bg-white dark:bg-gray-800 rounded text-xs font-mono">
                    {ip}:{shareInfo.port}
                  </span>
                ))}
              </div>
            </div>

            {/* QR Code */}
            {qrDataUrl && (
              <div className="flex justify-center">
                <img src={qrDataUrl} alt="QR Code" className="w-44 h-44" />
              </div>
            )}

            {/* ── Public Tunnel ── */}
            {tunnelActive ? (
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                  <Globe size={16} />
                  <span className="text-sm font-medium">公网共享已开启</span>
                  <span className="ml-auto flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                    <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                    连接中
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500 dark:text-gray-400">公网地址（无需同一网络）</span>
                  <button
                    onClick={handleTunnelCopy}
                    className="text-xs text-[#007AFF] hover:underline flex items-center gap-1"
                  >
                    {tunnelCopied ? <Check size={12} /> : <Copy size={12} />}
                    {tunnelCopied ? '已复制' : '复制'}
                  </button>
                </div>
                <div className="bg-white dark:bg-gray-800 px-3 py-2 rounded text-xs font-mono truncate">
                  {tunnelUrl}
                </div>
                <Button variant="danger" size="sm" onClick={handleTunnelStop} className="w-full mt-1 text-xs py-1.5">
                  <GlobeOff size={14} />
                  关闭公网共享
                </Button>
              </div>
            ) : (
              <div className="bg-white dark:bg-gray-800 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Globe size={16} className="text-gray-400" />
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300">公网共享</span>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleTunnelStart}
                    disabled={tunnelStarting}
                    className="text-xs py-1.5"
                  >
                    {tunnelStarting ? (
                      <>
                        <Loader2 size={12} className="animate-spin" />
                        连接中...
                      </>
                    ) : (
                      <>
                        <Globe size={12} />
                        开启
                      </>
                    )}
                  </Button>
                </div>
                {tunnelError && (
                  <div className="mt-2 text-xs text-red-500 bg-red-50 dark:bg-red-900/20 px-2 py-1.5 rounded">
                    {tunnelError}
                  </div>
                )}
                <p className="mt-1.5 text-xs text-gray-400">
                  开启后可通过公网地址访问，无需端口转发，网络中的任何人都可查看
                </p>
              </div>
            )}

            {/* Connected Users */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-3">
              <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
                <Users size={14} />
                <span>在线访客 ({connectedUsers.length})</span>
              </div>
              {connectedUsers.length === 0 ? (
                <div className="text-xs text-gray-400 text-center py-2">暂无访客连接</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {connectedUsers.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center gap-1.5 px-2 py-1 bg-green-50 dark:bg-green-900/20 rounded-full text-xs"
                    >
                      <div className="w-5 h-5 rounded-full bg-[#007AFF] flex items-center justify-center text-[10px] font-bold text-white">
                        {u.nickname.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-green-700 dark:text-green-300 font-medium">{u.nickname}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Real-time Tag Activity */}
            {tagActivities.length > 0 && (
              <div className="bg-white dark:bg-gray-800 rounded-lg p-3 max-h-32 overflow-y-auto">
                <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
                  <Activity size={14} />
                  <span>实时动态</span>
                </div>
                <div className="space-y-1">
                  {tagActivities.slice(0, 10).map((act) => (
                    <div key={act.id} className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                      <Tag size={10} />
                      <strong className="text-gray-700 dark:text-gray-200">{act.nickname}</strong>
                      {act.action === 'added' ? '标记了' : '移除了'}
                      <span
                        className="px-1 rounded font-medium"
                        style={{ backgroundColor: 'rgba(99,102,241,0.15)', color: '#6366f1' }}
                      >
                        {act.tagName}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Stop button */}
            <Button variant="danger" size="sm" onClick={handleStopShare} className="w-full">
              <StopCircle size={16} />
              停止共享
            </Button>
          </div>
        ) : (
          /* Start button */
          <Button
            variant="primary"
            onClick={handleStartShare}
            disabled={!targetEventId || sharing}
            className="w-full"
          >
            {sharing ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                启动中...
              </>
            ) : (
              <>
                <Share2 size={16} />
                开始共享
              </>
            )}
          </Button>
        )}

        {/* Instructions */}
        <div className="text-xs text-gray-400 space-y-1 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3">
          <div className="flex items-center gap-1"><Wifi size={12} /> <strong>局域网共享</strong>：同一网络下的设备访问局域网地址</div>
          <div className="flex items-center gap-1"><Globe size={12} /> <strong>公网共享</strong>：开启后生成公网地址，任意网络都可访问</div>
          <div>浏览器访问地址即可进入，设置昵称后浏览照片</div>
          <div>网页端可以给照片打标签，标签会实时同步到所有连接的设备</div>
        </div>
      </div>
    </Dialog>
  )
}

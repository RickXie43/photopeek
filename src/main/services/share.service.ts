import { createServer, IncomingMessage, ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { getDb } from '../db/connection'
import { getEventDir, getLibraryPath } from './library.service'
import { syncEventJsonPhotos } from '../ipc/event.handler'
import Bonjour from 'bonjour-service'
import { Tunnel } from 'cloudflared'

interface TunnelInfo {
  tunnel: Tunnel
  url: string
}

/** A connected web user */
interface WebUser {
  id: string
  nickname: string
  joinedAt: string
  ws: WebSocket
}

interface ShareSession {
  eventId: string
  port: number
  server: ReturnType<typeof createServer>
  wss: WebSocketServer
  users: Map<string, WebUser>
  bonjour?: any
}

const sessions = new Map<string, ShareSession>()
const tunnels = new Map<string, TunnelInfo>()

function getLocalIPs(): string[] {
  const ips: string[] = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address)
      }
    }
  }
  return ips
}

/** Send a JSON message to a WebSocket client */
function wsSend(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

/** Broadcast a message to all connected web users of a session */
function broadcastUsers(session: ShareSession, data: unknown): void {
  for (const user of session.users.values()) {
    wsSend(user.ws, data)
  }
}

/** Notify all renderer windows about user list change */
function notifyRendererUsers(session: ShareSession): void {
  const userList = Array.from(session.users.values()).map(u => ({
    id: u.id,
    nickname: u.nickname,
    joinedAt: u.joinedAt,
  }))
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('share:users-update', {
      eventId: session.eventId,
      users: userList,
    })
  }
}

/** Notify renderer about a tag action from a web user */
function notifyRendererTagAction(
  eventId: string,
  userId: string,
  nickname: string,
  action: 'added' | 'removed',
  photoId: string,
  tagName: string,
): void {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('share:tag-action', {
      eventId,
      userId,
      nickname,
      action,
      photoId,
      tagName,
      timestamp: new Date().toISOString(),
    })
  }
}

// ─── Web App HTML ───────────────────────────────────────────────────────────

function getWebAppHtml(port: number, hostname: string, useWss: boolean = false): string {
  // When accessed through a tunnel (Cloudflare, ngrok, etc.), the WS must connect
  // via wss:// on the same hostname — not ws://hostname:localPort.
  const wsUrl = useWss
    ? `wss://${hostname}`
    : `ws://${hostname}:${port}`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>PhotoPeek - 事件查看</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#1c1c1e;--surface:#2c2c2e;--surface2:#3a3a3c;--text:#f5f5f7;--text2:#a1a1a6;--accent:#007AFF;--accent-hover:#0066CC;--radius:12px;--radius-sm:8px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100dvh;overflow-x:hidden}
input,button,select{font-family:inherit}

/* Login Screen */
#login-screen{display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:20px}
.login-card{background:var(--surface);border-radius:var(--radius);padding:40px 32px;width:100%;max-width:360px;text-align:center}
.login-card h1{font-size:28px;margin-bottom:4px}
.login-card p{color:var(--text2);font-size:14px;margin-bottom:24px}
.login-card input{width:100%;padding:12px 16px;border-radius:var(--radius-sm);border:1px solid var(--surface2);background:var(--surface2);color:var(--text);font-size:16px;outline:none;transition:border-color .2s}
.login-card input:focus{border-color:var(--accent)}
.login-card button{width:100%;margin-top:16px;padding:12px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:#fff;font-size:16px;font-weight:600;cursor:pointer;transition:background .2s}
.login-card button:hover{background:var(--accent-hover)}
.login-card button:disabled{opacity:.5;cursor:not-allowed}
.login-error{color:#ff453a;font-size:13px;margin-top:8px;min-height:20px}

/* Main App */
#main-app{display:none}

/* Top Bar */
.top-bar{position:sticky;top:0;z-index:100;background:var(--bg);padding:12px 16px;border-bottom:1px solid var(--surface2);display:flex;align-items:center;justify-content:space-between}
.top-bar .user-info{display:flex;align-items:center;gap:8px}
.top-bar .avatar{width:32px;height:32px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0}
.top-bar .nickname{font-size:14px;font-weight:600}
.top-bar .photo-count{font-size:12px;color:var(--text2)}
.leave-btn{padding:6px 14px;border:1px solid var(--surface2);border-radius:var(--radius-sm);background:transparent;color:var(--text);font-size:13px;cursor:pointer;transition:all .2s}
.leave-btn:hover{background:#ff453a;border-color:#ff453a;color:#fff}

/* Thumbnail size slider */
.size-control{display:flex;align-items:center;padding:0 8px}
.size-slider{width:60px;height:3px;-webkit-appearance:none;appearance:none;background:var(--surface2);border-radius:2px;outline:none;cursor:pointer}
.size-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:var(--accent);border:2px solid var(--bg);cursor:pointer;transition:transform .15s}
.size-slider::-webkit-slider-thumb:hover{transform:scale(1.2)}
.size-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--accent);border:2px solid var(--bg);cursor:pointer}

/* Photo Grid */
#photo-grid{padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--thumb-size,150px),1fr));gap:8px}
.photo-card{position:relative;aspect-ratio:1;border-radius:var(--radius-sm);overflow:hidden;cursor:pointer;background:var(--surface);transition:transform .15s}
.photo-card:hover{transform:scale(1.02)}
.photo-card img{width:100%;height:100%;object-fit:cover}
.photo-card .tag-badges{position:absolute;bottom:4px;left:4px;right:4px;display:flex;flex-wrap:wrap;gap:2px;pointer-events:none}
.photo-card .tag-badges span{font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.6);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70px}

/* Photo Detail / Loupe */
#photo-detail{display:none;position:fixed;inset:0;z-index:200;background:#000}
#photo-detail.show{display:flex;flex-direction:column}
.detail-top{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(180deg,rgba(0,0,0,.8),transparent);flex-shrink:0;position:absolute;top:0;left:0;right:0;z-index:20}
.detail-top button{background:none;border:none;color:#fff;font-size:22px;cursor:pointer;padding:6px 10px;border-radius:8px;transition:background .2s}
.detail-top button:hover{background:rgba(255,255,255,.15)}
.detail-top .photo-name{font-size:13px;color:rgba(255,255,255,.7);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}
.detail-image-wrap{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;touch-action:pan-y;min-height:0}
.detail-image-wrap img{max-width:100%;max-height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;transition:opacity .25s ease}
.detail-image-wrap img.fade-in{opacity:0}
.detail-image-wrap img.fade-in.loaded{opacity:1}
.detail-nav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.08);color:#fff;border:none;font-size:24px;width:44px;height:44px;cursor:pointer;border-radius:50%;transition:all .25s;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);opacity:0}
#photo-detail.show:hover .detail-nav{opacity:1}
.detail-nav:hover{background:rgba(255,255,255,.2);transform:translateY(-50%) scale(1.1)}
.detail-nav.prev{left:16px}
.detail-nav.next{right:16px}

/* Tag bar below photo */
.detail-tags-bar{display:flex;align-items:center;gap:8px;padding:10px 16px;background:rgba(30,30,32,.95);border-top:1px solid rgba(255,255,255,.08);flex-shrink:0;backdrop-filter:blur(12px)}
.detail-tags-label{font-size:15px;flex-shrink:0}
.detail-tags-list{display:flex;flex-wrap:wrap;gap:6px;overflow-y:auto;max-height:60px}
.detail-tag-chip{display:inline-flex;align-items:center;gap:4px;padding:5px 14px;border-radius:16px;font-size:13px;font-weight:500;background:rgba(255,255,255,.1);color:rgba(255,255,255,.85);white-space:nowrap;pointer-events:none}
.detail-tag-chip.is-mine{background:rgba(0,122,255,.65);color:#fff}

/* Connected Users Bar */
.users-bar{display:flex;align-items:center;gap:6px;padding:8px 16px;background:var(--surface);border-bottom:1px solid var(--surface2);overflow-x:auto;flex-shrink:0}
.users-bar .user-dot{width:6px;height:6px;border-radius:50%;background:#30d158;flex-shrink:0}
.users-bar .users-label{font-size:12px;color:var(--text2);white-space:nowrap}
.users-bar .user-chip{font-size:11px;padding:2px 10px;border-radius:12px;background:var(--surface2);color:var(--text2);white-space:nowrap}

/* Nickname tag highlight */
.tag-btn.is-mine{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}

/* Double-click hint overlay */
.dbl-hint{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.55);color:#fff;border-radius:6px;padding:3px 7px;font-size:9px;opacity:0;transition:opacity .2s;pointer-events:none;backdrop-filter:blur(4px)}
.photo-card:hover .dbl-hint{opacity:1}

/* Bottom action buttons */
.detail-actions{position:absolute;bottom:16px;right:16px;display:flex;gap:8px;z-index:10}
.detail-actions button{padding:8px 14px;border-radius:10px;background:rgba(0,0,0,.55);color:#fff;border:none;font-size:12px;cursor:pointer;transition:all .2s;backdrop-filter:blur(8px);display:flex;align-items:center;gap:4px}
.detail-actions button:hover{background:rgba(255,255,255,.2);transform:translateY(-1px)}
.detail-actions button:active{transform:translateY(0)}
.detail-actions button.loading{opacity:.5;pointer-events:none}

/* Tag filter bar */
.tag-filter-bar{display:flex;align-items:center;gap:6px;padding:8px 16px;background:var(--surface);border-bottom:1px solid var(--surface2);overflow-x:auto;flex-shrink:0}
.tag-filter-bar .filter-label{font-size:11px;color:var(--text2);white-space:nowrap;margin-right:4px}
.tag-filter-chip{padding:4px 12px;border-radius:14px;border:1px solid var(--surface2);background:transparent;color:var(--text2);font-size:11px;cursor:pointer;transition:all .2s;white-space:nowrap}
.tag-filter-chip:hover{border-color:var(--accent);color:var(--accent)}
.tag-filter-chip.active{background:var(--accent);border-color:var(--accent);color:#fff}
.tag-filter-chip.active-filter{background:rgba(0,122,255,.15);border-color:var(--accent);color:var(--accent)}

/* Save all button + progress */
.grid-footer{padding:12px 16px 20px;text-align:center}
.save-all-btn{padding:10px 24px;border-radius:10px;background:var(--accent);color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:6px}
.save-all-btn:hover{background:var(--accent-hover);transform:translateY(-1px)}
.save-all-btn:active{transform:translateY(0)}
.save-all-btn.loading{opacity:.6;pointer-events:none}
.save-progress{margin-top:8px;display:none}
.save-progress.active{display:block}
.save-progress-bar{height:4px;background:var(--surface2);border-radius:4px;overflow:hidden}
.save-progress-bar-fill{height:100%;background:var(--accent);border-radius:4px;transition:width .15s ease;width:0%}
.save-progress-text{font-size:11px;color:var(--text2);margin-top:4px}

/* Photo counter badge */
.detail-counter-badge{position:absolute;bottom:16px;left:16px;z-index:10;padding:5px 12px;border-radius:8px;background:rgba(0,0,0,.45);color:rgba(255,255,255,.8);font-size:12px;backdrop-filter:blur(8px)}

/* Activity Toast */
.toast-container{position:fixed;bottom:80px;right:16px;z-index:300;display:flex;flex-direction:column-reverse;gap:6px;pointer-events:none}
.toast{background:rgba(44,44,46,.92);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 16px;font-size:13px;color:var(--text2);animation:toastIn .35s ease-out;max-width:280px;backdrop-filter:blur(12px)}
.toast strong{color:var(--text)}
@keyframes toastIn{from{opacity:0;transform:translateY(12px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}

/* Responsive */
@media(min-width:768px){#photo-grid{padding:16px;gap:12px}}
</style>
</head>
<body>

<!-- Login Screen -->
<div id="login-screen">
  <div class="login-card">
    <h1>📸 PhotoPeek</h1>
    <p>输入昵称进入事件相册</p>
    <input type="text" id="nickname-input" placeholder="你的昵称..." maxlength="20" autofocus />
    <div class="login-error" id="login-error"></div>
    <button id="join-btn" disabled>进入</button>
  </div>
</div>

<!-- Main App -->
<div id="main-app">
  <!-- Top Bar -->
  <div class="top-bar">
    <div class="user-info">
      <div class="avatar" id="user-avatar"></div>
      <div>
        <div class="nickname" id="user-nickname"></div>
        <div class="photo-count" id="photo-count-label"></div>
      </div>
    </div>
    <div class="size-control">
      <input type="range" id="thumb-size-slider" min="80" max="320" value="150" class="size-slider" />
    </div>
    <button class="leave-btn" id="leave-btn">退出</button>
  </div>

  <!-- Connected Users Bar -->
  <div class="users-bar" id="users-bar">
    <div class="user-dot"></div>
    <span class="users-label" id="users-label">在线:</span>
  </div>

  <!-- Tag Filter Bar -->
  <div class="tag-filter-bar" id="tag-filter-bar">
    <span class="filter-label">🏷️ 筛选:</span>
  </div>

  <!-- Photo Grid -->
  <div id="photo-grid"></div>

  <!-- Grid Footer -->
  <div class="grid-footer" id="grid-footer">
    <button class="save-all-btn" id="save-all-btn">� 打包下载 ZIP</button>
    <div class="save-progress" id="save-progress">
      <div class="save-progress-bar"><div class="save-progress-bar-fill" id="save-progress-fill"></div></div>
      <div class="save-progress-text" id="save-progress-text"></div>
    </div>
  </div>
</div>

<!-- Photo Detail / Loupe -->
<div id="photo-detail">
  <div class="detail-top">
    <button id="detail-back">✕</button>
    <span class="photo-name" id="detail-photo-name"></span>
    <span id="detail-counter" style="font-size:13px;color:rgba(255,255,255,.5)"></span>
  </div>
  <div class="detail-image-wrap" id="detail-image-wrap">
    <button class="detail-nav prev" id="detail-prev">‹</button>
    <img id="detail-image" src="" alt="" />
    <div class="detail-counter-badge" id="detail-counter-badge"></div>
    <button class="detail-nav next" id="detail-next">›</button>
    <div class="detail-actions">
      <button id="view-original-btn">📷 原图</button>
      <button id="save-image-btn">💾 保存</button>
    </div>
  </div>
  <div class="detail-tags-bar" id="detail-tags-bar">
    <span class="detail-tags-label">🏷️</span>
    <div class="detail-tags-list" id="detail-tags-list"></div>
  </div>
</div>

<!-- Toast Container -->
<div class="toast-container" id="toast-container"></div>

<script>
(function(){
  // ─── State ──────────────────────────────────────────────────────────────
  const WS_URL = '${wsUrl}'
  let ws = null
  let myNickname = ''
  let myId = ''
  let eventData = null // parsed event.json
  let photoOrder = []  // sorted photo ids
  let currentPhotoIndex = -1
  let reconnectTimer = null
  let connectedUsers = []
  let originalLoadedMap = {} // photoId -> true/false
  let shutdownFlag = false
  let activeFilterTagIds = new Set() // Set of tag IDs, empty = show all

  // DOM refs
  const loginScreen = document.getElementById('login-screen')
  const mainApp = document.getElementById('main-app')
  const nicknameInput = document.getElementById('nickname-input')
  const joinBtn = document.getElementById('join-btn')
  const loginError = document.getElementById('login-error')
  const leaveBtn = document.getElementById('leave-btn')
  const photoGrid = document.getElementById('photo-grid')
  const thumbSizeSlider = document.getElementById('thumb-size-slider')
  const photoDetail = document.getElementById('photo-detail')
  const detailImage = document.getElementById('detail-image')
  const detailImageWrap = document.getElementById('detail-image-wrap')
  const detailBack = document.getElementById('detail-back')
  const detailPrev = document.getElementById('detail-prev')
  const detailNext = document.getElementById('detail-next')
  const detailPhotoName = document.getElementById('detail-photo-name')
  const detailCounter = document.getElementById('detail-counter')
  const detailCounterBadge = document.getElementById('detail-counter-badge')
  const detailTagsList = document.getElementById('detail-tags-list')
  const usersBar = document.getElementById('users-bar')
  const usersLabel = document.getElementById('users-label')
  const toastContainer = document.getElementById('toast-container')
  const userAvatar = document.getElementById('user-avatar')
  const userNickname = document.getElementById('user-nickname')
  const photoCountLabel = document.getElementById('photo-count-label')
  const viewOriginalBtn = document.getElementById('view-original-btn')
  const saveImageBtn = document.getElementById('save-image-btn')
  const tagFilterBar = document.getElementById('tag-filter-bar')
  const saveAllBtn = document.getElementById('save-all-btn')

  // ─── WebSocket ──────────────────────────────────────────────────────────
  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', userId: myNickname }))
    }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        handleWsMessage(msg)
      } catch(err) { console.error('WS parse error', err) }
    }
    ws.onclose = () => {
      ws = null
      scheduleReconnect()
    }
    ws.onerror = () => { ws && ws.close() }
  }

  function scheduleReconnect() {
    if (reconnectTimer || shutdownFlag) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!ws || ws.readyState === WebSocket.CLOSED) connectWs()
    }, 3000)
  }

  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
  }

  // ─── Message Handler ────────────────────────────────────────────────────
  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        myId = msg.yourId
        break
      case 'sync':
        eventData = msg.payload
        // Persist active filter across syncs
        buildPhotoOrder()
        renderGrid()
        if (currentPhotoIndex >= 0) renderDetail()
        renderTagFilterBar()
        updatePhotoCount()
        break
      case 'users':
        connectedUsers = msg.users || []
        renderUsersBar()
        break
      case 'tagAction':
        showToast(msg.nickname + (msg.action === 'added' ? ' 标记了 ' : ' 移除了 ') + msg.tagName)
        break
      case 'shutdown':
        // Host stopped sharing — prevent reconnect, show message
        shutdownFlag = true
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
        if (ws) { ws.onclose = null; ws.close(); ws = null }
        photoDetail.classList.remove('show')
        mainApp.style.display = 'none'
        loginScreen.style.display = 'flex'
        document.getElementById('nickname-input').value = ''
        document.getElementById('join-btn').disabled = true
        document.getElementById('join-btn').textContent = '进入'
        loginError.textContent = '⚠️ 主机已停止共享'
        loginError.style.color = '#ff453a'
        break
    }
  }

  // ─── Data Helpers ───────────────────────────────────────────────────────
  function buildPhotoOrder() {
    if (!eventData || !eventData.photos) { photoOrder = []; return }
    let ids = Object.keys(eventData.photos).filter(id => !eventData.photos[id].deletedAt)
    // Apply tag filter (AND logic: photo must have ALL selected tags)
    if (activeFilterTagIds.size > 0) {
      ids = ids.filter(id => {
        const p = eventData.photos[id]
        if (!p || !p.tags) return false
        // Photo must have every tag in the active set
        for (const tid of activeFilterTagIds) {
          if (!p.tags.includes(tid)) return false
        }
        return true
      })
    }
    photoOrder = ids.sort()
  }

  function getPhoto(id) { return eventData && eventData.photos ? eventData.photos[id] : null }
  function getTags() { return eventData && eventData.tags ? eventData.tags : [] }
  function getPhotoTags(photoId) {
    const photo = getPhoto(photoId)
    if (!photo || !photo.tags) return []
    const allTags = getTags()
    return photo.tags.map(tid => allTags.find(t => t.id === tid)).filter(Boolean)
  }

  // ─── Render: Photo Grid ─────────────────────────────────────────────────
  function renderGrid() {
    if (!eventData || photoOrder.length === 0) {
      photoGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px 16px;color:var(--text2);font-size:14px">暂无照片</div>'
      return
    }
    let html = ''
    for (const id of photoOrder) {
      const photo = getPhoto(id)
      if (!photo) continue
      const pTags = getPhotoTags(id)
      const badges = pTags.map(t => '<span style="background:' + (t.color || '#6366f1') + '80">' + escHtml(t.name) + '</span>').join('')
      const thumbUrl = '/thumbnail/' + id
      const hasMyTag = pTags.some(t => t && t.name === myNickname)
      html += '<div class="photo-card' + (hasMyTag ? ' has-my-tag' : '') + '" data-photo-id="' + id + '">'
        + '<img src="' + thumbUrl + '" alt="' + escHtml(photo.fileName || '') + '" loading="lazy" />'
        + '<span class="dbl-hint">⚡双击标记</span>'
        + (badges ? '<div class="tag-badges">' + badges + '</div>' : '')
        + '</div>'
    }
    photoGrid.innerHTML = html

    // Click handler (open detail)
    photoGrid.querySelectorAll('.photo-card').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.detail >= 2) return // double-click will fire separately
        const pid = el.dataset.photoId
        const idx = photoOrder.indexOf(pid)
        if (idx >= 0) openDetail(idx)
      })
    })

    // Double-click handler (nickname tag toggle)
    photoGrid.querySelectorAll('.photo-card').forEach(el => {
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        const pid = el.dataset.photoId
        toggleNicknameTag(pid)
      })
    })
  }

  // ─── Render: Detail View ────────────────────────────────────────────────
  function openDetail(index) {
    currentPhotoIndex = index
    photoDetail.classList.add('show')
    renderDetail()
  }

  function closeDetail() {
    photoDetail.classList.remove('show')
    currentPhotoIndex = -1
  }

  function renderDetail() {
    if (currentPhotoIndex < 0 || currentPhotoIndex >= photoOrder.length) return
    const id = photoOrder[currentPhotoIndex]
    const photo = getPhoto(id)
    if (!photo) return

    detailImage.classList.remove('loaded')
    detailImage.classList.add('fade-in')
    // Show loading state
    viewOriginalBtn.textContent = '⏳ 加载原图...'
    viewOriginalBtn.classList.add('loading')
    viewOriginalBtn.disabled = true
    // Load original photo — only when this photo is opened
    detailImage.src = '/photo/' + id
    detailImage.onload = () => {
      detailImage.classList.add('loaded')
      originalLoadedMap[id] = true
      viewOriginalBtn.classList.remove('loading')
      viewOriginalBtn.textContent = '✅ 原图'
      viewOriginalBtn.disabled = true
    }
    detailImage.onerror = () => {
      // Fallback to thumbnail if original fails
      console.warn('Failed to load original, falling back to thumbnail')
      detailImage.src = '/thumbnail/' + id
      detailImage.onload = () => { detailImage.classList.add('loaded') }
      originalLoadedMap[id] = false
      viewOriginalBtn.classList.remove('loading')
      viewOriginalBtn.textContent = '📇 缩略图'
      viewOriginalBtn.disabled = true
    }
    detailPhotoName.textContent = photo.fileName || ''
    detailCounter.textContent = (currentPhotoIndex + 1) + ' / ' + photoOrder.length
    detailCounterBadge.textContent = (currentPhotoIndex + 1) + ' / ' + photoOrder.length

    // Render tags below photo
    const pTags = getPhotoTags(id)
    let tagHtml = ''
    if (pTags.length === 0) {
      tagHtml = '<span style="color:rgba(255,255,255,.3);font-size:12px">无标签 · 空格/双击添加本人标签 · j/k 切换</span>'
    } else {
      for (const tag of pTags) {
        if (!tag) continue
        const isMine = tag.name === myNickname
        tagHtml += '<span class="detail-tag-chip' + (isMine ? ' is-mine' : '') + '">' + escHtml(tag.name) + '</span>'
      }
    }
    detailTagsList.innerHTML = tagHtml

    // Double-click on image to toggle own nickname tag
    detailImage.ondblclick = (e) => {
      e.stopPropagation()
      toggleNicknameTag(id)
    }

    // View original button — just a status indicator (original loads automatically)
    viewOriginalBtn.onclick = null

    // Save image button — always saves original
    saveImageBtn.onclick = () => {
      const imgSrc = '/photo/' + id
      const fileName = photo.fileName || 'photo-' + id + '.jpg'
      // Try download via anchor (desktop: Save As, mobile: save to gallery)
      const link = document.createElement('a')
      link.href = imgSrc
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      // Fallback for mobile browsers that ignore download attribute
      setTimeout(() => {
        if (!link.download) {
          window.open(imgSrc, '_blank')
        }
      }, 300)
      showToast('💾 正在保存 ' + fileName)
    }

    // Keyboard nav
    detailPrev.onclick = () => { if (currentPhotoIndex > 0) openDetail(currentPhotoIndex - 1) }
    detailNext.onclick = () => { if (currentPhotoIndex < photoOrder.length - 1) openDetail(currentPhotoIndex + 1) }
  }

  // Keyboard events for detail view
  document.addEventListener('keydown', (e) => {
    if (!photoDetail.classList.contains('show')) return
    // Prevent default scrolling for navigation keys
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'j', 'J', 'k', 'K', ' '].includes(e.key)) {
      e.preventDefault()
    }
    if (e.key === 'Escape') { closeDetail(); return }
    // Navigate: j/↓ next, k/↑ previous, ← previous, → next
    if (e.key === 'ArrowRight' || e.key === 'j' || e.key === 'J') {
      if (currentPhotoIndex < photoOrder.length - 1) openDetail(currentPhotoIndex + 1)
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'k' || e.key === 'K') {
      if (currentPhotoIndex > 0) openDetail(currentPhotoIndex - 1)
      return
    }
    // Space → toggle nickname tag on current photo
    if (e.key === ' ' && currentPhotoIndex >= 0) {
      toggleNicknameTag(photoOrder[currentPhotoIndex])
      return
    }
  })

  detailBack.addEventListener('click', closeDetail)

  // ─── Render: Users Bar ──────────────────────────────────────────────────
  function renderUsersBar() {
    if (connectedUsers.length === 0) {
      usersBar.innerHTML = '<div class="user-dot"></div><span class="users-label">等待连接...</span>'
      return
    }
    let html = '<div class="user-dot"></div><span class="users-label">在线 (' + connectedUsers.length + '):</span>'
    for (const u of connectedUsers) {
      html += '<span class="user-chip">' + escHtml(u.nickname) + '</span>'
    }
    usersBar.innerHTML = html
  }

  // ─── Render: Tag Filter Bar ──────────────────────────────────────────────
  function renderTagFilterBar() {
    const allTags = getTags()
    if (allTags.length === 0) {
      tagFilterBar.innerHTML = '<span class="filter-label">🏷️ 暂无标签</span>'
      return
    }
    let html = '<span class="filter-label">🏷️ 筛选:</span>'
    // "All" chip
    const isAll = activeFilterTagIds.size === 0
    html += '<button class="tag-filter-chip' + (isAll ? ' active' : '') + '" data-tag-id="">全部</button>'
    for (const tag of allTags) {
      const active = activeFilterTagIds.has(tag.id)
      html += '<button class="tag-filter-chip' + (active ? ' active' : '') + '" data-tag-id="' + tag.id + '">' + escHtml(tag.name) + '</button>'
    }
    tagFilterBar.innerHTML = html

    // Click handlers
    tagFilterBar.querySelectorAll('.tag-filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const tagId = btn.dataset.tagId
        if (!tagId) {
          // "All" clicked — clear all selections
          activeFilterTagIds.clear()
        } else if (activeFilterTagIds.has(tagId)) {
          // Already selected — remove it
          activeFilterTagIds.delete(tagId)
        } else {
          // Not selected — add it
          activeFilterTagIds.add(tagId)
        }
        buildPhotoOrder()
        // Reset detail view if current photo is no longer in the filtered set
        if (currentPhotoIndex >= 0 && !photoOrder.includes(photoOrder[currentPhotoIndex])) {
          currentPhotoIndex = -1
          photoDetail.classList.remove('show')
        }
        renderGrid()
        renderTagFilterBar()
        updatePhotoCount()
      })
    })
  }

  // ─── Toast ──────────────────────────────────────────────────────────────
  function showToast(text) {
    const el = document.createElement('div')
    el.className = 'toast'
    el.innerHTML = text
    toastContainer.appendChild(el)
    setTimeout(() => { if (el.parentNode) el.remove() }, 3000)
  }

  // ─── Nickname Tag Toggle (double-click) ────────────────────────────────
  function toggleNicknameTag(photoId) {
    if (!photoId) return
    wsSend({ type: 'nicknameTagToggle', photoId: photoId, userId: myNickname })
    // Optimistic: find the tag in current data and toggle its visual
    const allTags = getTags()
    const myTag = allTags.find(t => t.name === myNickname)
    if (myTag) {
      const photo = getPhoto(photoId)
      if (photo) {
        const hadTag = photo.tags && photo.tags.includes(myTag.id)
        if (hadTag) {
          photo.tags = photo.tags.filter(tid => tid !== myTag.id)
        } else {
          if (!photo.tags) photo.tags = []
          photo.tags.push(myTag.id)
        }
      }
    }
    renderGrid()
    if (currentPhotoIndex >= 0) renderDetail()
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  function escHtml(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

  function updatePhotoCount() {
    const total = eventData && eventData.photos ? Object.keys(eventData.photos).filter(id => !eventData.photos[id].deletedAt).length : 0
    const shown = photoOrder.length
    photoCountLabel.textContent = activeFilterTagIds.size > 0
      ? shown + ' / ' + total + ' 张照片'
      : total + ' 张照片'
    saveAllBtn.textContent = '📦 打包下载 ZIP (' + shown + ' 张)'
  }

  // ─── Login ──────────────────────────────────────────────────────────────
  nicknameInput.addEventListener('input', () => {
    const trimmed = nicknameInput.value.trim()
    joinBtn.disabled = trimmed.length === 0
    loginError.textContent = ''
  })

  nicknameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click()
  })

  joinBtn.addEventListener('click', () => {
    const nickname = nicknameInput.value.trim()
    if (!nickname) return
    myNickname = nickname
    joinBtn.disabled = true
    joinBtn.textContent = '连接中...'

    // Fetch event data first, then connect WebSocket
    fetch('/event.json')
      .then(r => r.json())
      .then(data => {
        eventData = data
        buildPhotoOrder()
        loginScreen.style.display = 'none'
        mainApp.style.display = 'block'
        userAvatar.textContent = myNickname.charAt(0).toUpperCase()
        userNickname.textContent = myNickname
        updatePhotoCount()
        renderGrid()
        renderUsersBar()
        renderTagFilterBar()
        connectWs()
      })
      .catch(err => {
        loginError.textContent = '连接失败，请检查地址是否正确'
        joinBtn.disabled = false
        joinBtn.textContent = '进入'
      })
  })

  leaveBtn.addEventListener('click', () => {
    if (ws) { wsSend({ type: 'leave' }); ws.close() }
    ws = null
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    location.reload()
  })

  // ─── Save All as ZIP ──────────────────────────────────────────────────
  saveAllBtn.addEventListener('click', () => {
    const ids = photoOrder
    if (ids.length === 0) { showToast('没有可保存的照片'); return }
    // Trigger ZIP download — one file, one confirmation dialog
    const link = document.createElement('a')
    link.href = '/download-zip'
    link.download = 'photopeek.zip'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    showToast('📦 正在下载 ZIP 包 (' + ids.length + ' 张照片)')
  })

  // ─── Thumbnail Size Slider ────────────────────────────────────────────
  // Restore saved size from localStorage
  const savedSize = localStorage.getItem('photopeek-thumb-size')
  if (savedSize) {
    const v = parseInt(savedSize, 10)
    if (v >= 80 && v <= 320) {
      thumbSizeSlider.value = String(v)
      photoGrid.style.setProperty('--thumb-size', v + 'px')
    }
  }
  thumbSizeSlider.addEventListener('input', () => {
    const val = thumbSizeSlider.value
    photoGrid.style.setProperty('--thumb-size', val + 'px')
    localStorage.setItem('photopeek-thumb-size', val)
  })

  // ─── Touch: swipe to navigate + double-tap for tag toggle ──────────────
  let touchStartX = 0
  let touchStartY = 0
  let lastTapTime = 0
  let touchMoved = false

  detailImageWrap.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX
    touchStartY = e.touches[0].clientY
    touchMoved = false
  }, { passive: true })

  detailImageWrap.addEventListener('touchmove', (e) => {
    const dx = e.touches[0].clientX - touchStartX
    const dy = e.touches[0].clientY - touchStartY
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) touchMoved = true
  }, { passive: true })

  detailImageWrap.addEventListener('touchend', (e) => {
    const now = Date.now()
    const diffX = e.changedTouches[0].clientX - touchStartX
    const diffY = e.changedTouches[0].clientY - touchStartY

    if (!touchMoved && Math.abs(diffX) < 15 && Math.abs(diffY) < 15) {
      // This is a tap — detect double-tap
      if (now - lastTapTime < 350 && currentPhotoIndex >= 0) {
        // Double-tap: toggle nickname tag on current photo
        e.preventDefault()
        if (currentPhotoIndex >= 0) {
          toggleNicknameTag(photoOrder[currentPhotoIndex])
        }
        lastTapTime = 0
        return
      }
      lastTapTime = now
      return
    }

    // Swipe detection (only horizontal swipes)
    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
      e.preventDefault()
      if (diffX > 0 && currentPhotoIndex > 0) {
        openDetail(currentPhotoIndex - 1)
      } else if (diffX < 0 && currentPhotoIndex < photoOrder.length - 1) {
        openDetail(currentPhotoIndex + 1)
      }
    }
  }, { passive: false })

})()
</script>
</body>
</html>`
}

// ─── Server ────────────────────────────────────────────────────────────────

export async function startShare(eventId: string, port: number = 0): Promise<{ port: number; ips: string[]; url: string }> {
  // Stop existing session for this event
  stopShare(eventId)

  const folderName = getEventFolderNameFromDb(eventId)
  const eventDir = getEventDir(folderName)

  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.json': 'application/json', '.html': 'text/html',
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost`)
    res.setHeader('Access-Control-Allow-Origin', '*')

    // ── API: event.json ───────────────────────────────────────────────
    if (url.pathname === '/event.json') {
      const metaPath = path.join(eventDir, 'event.json')
      if (fs.existsSync(metaPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(fs.readFileSync(metaPath))
      } else {
        res.writeHead(404)
        res.end('{}')
      }
      return
    }

    // ── API: thumbnail ────────────────────────────────────────────────
    if (url.pathname.startsWith('/thumbnail/')) {
      const photoId = url.pathname.slice('/thumbnail/'.length)
      const searchDir = path.join(getLibraryPath(), 'thumbnails')
      const found = findFile(searchDir, photoId)
      if (found) {
        const ext = path.extname(found).toLowerCase()
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'image/jpeg' })
        res.end(fs.readFileSync(found))
      } else {
        res.writeHead(404)
        res.end('')
      }
      return
    }

    // ── API: original photo ──────────────────────────────────────────
    if (url.pathname.startsWith('/photo/')) {
      const photoId = url.pathname.slice('/photo/'.length)
      const metaPath = path.join(eventDir, 'event.json')
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          const photoInfo = meta.photos?.[photoId]
          if (photoInfo?.fileName) {
            // Search for the file in the event directory recursively
            const found = findFileInDir(eventDir, photoInfo.fileName)
            if (found) {
              const ext = path.extname(found).toLowerCase()
              res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'image/jpeg' })
              res.end(fs.readFileSync(found))
              return
            }
          }
        } catch {}
      }
      // Fallback: try thumbnails
      const searchDir = path.join(getLibraryPath(), 'thumbnails')
      const found2 = findFile(searchDir, photoId)
      if (found2) {
        const ext = path.extname(found2).toLowerCase()
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'image/jpeg' })
        res.end(fs.readFileSync(found2))
        return
      }
      res.writeHead(404)
      res.end('')
      return
    }

    // ── API: download ZIP of all photos ──────────────────────────────
    if (url.pathname === '/download-zip') {
      const metaPath = path.join(eventDir, 'event.json')
      if (!fs.existsSync(metaPath)) { res.writeHead(404); res.end(''); return }

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        const photoIds = Object.keys(meta.photos || {}).filter(id => !meta.photos[id].deletedAt)
        const files: { name: string; data: Buffer }[] = []

        for (const id of photoIds) {
          const info = meta.photos[id]
          if (!info?.fileName) continue
          const found = findFileInDir(eventDir, info.fileName)
          if (found) {
            files.push({ name: info.fileName, data: fs.readFileSync(found) })
          }
        }

        if (files.length === 0) { res.writeHead(404); res.end(''); return }

        const zipBuf = makeZip(files)
        const folderName = path.basename(eventDir)
        const disposition = `attachment; filename="${encodeURIComponent(folderName)}.zip"`
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': disposition,
          'Content-Length': String(zipBuf.length),
        })
        res.end(zipBuf)
      } catch (err) {
        console.error('[Share] ZIP error:', err)
        res.writeHead(500)
        res.end('')
      }
      return
    }

    // ── API: info ─────────────────────────────────────────────────────
    if (url.pathname === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ eventId, ips: getLocalIPs(), version: '1.0.0' }))
      return
    }

    // ── Default: serve web app ────────────────────────────────────────
    const hostname = req.headers['host']?.split(':')[0] || getLocalIPs()[0] || 'localhost'
    // Use actual port from the listening server
    const addr = server.address()
    const actualPort = typeof addr === 'object' && addr ? addr.port : port
    // Detect if request came through a tunnel (hostname is not a local IP)
    const localIPs = getLocalIPs()
    const isTunnelRequest = hostname !== 'localhost' && !localIPs.includes(hostname)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(getWebAppHtml(actualPort, hostname, isTunnelRequest))
  })

  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws: WebSocket) => {
    const session = sessions.get(eventId)
    if (!session) { ws.close(1011, 'Session ended'); return }

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        handleWsMessage(session, eventId, eventDir, ws, msg)
      } catch { /* ignore malformed messages */ }
    })

    ws.on('close', () => {
      // Find and remove the user associated with this socket
      for (const [uid, user] of session.users.entries()) {
        if (user.ws === ws) {
          session.users.delete(uid)
          notifyRendererUsers(session)
          // Notify remaining users
          broadcastUsers(session, {
            type: 'users',
            users: Array.from(session.users.values()).map(u => ({ id: u.id, nickname: u.nickname, joinedAt: u.joinedAt })),
          })
          break
        }
      }
    })
  })

  // Wait for server to start listening
  const actualPort = await new Promise<number>((resolve, reject) => {
    server.listen(port, () => {
      const addr = server.address()
      const ap = typeof addr === 'object' && addr ? addr.port : port
      resolve(ap)
    })
    server.on('error', (err) => reject(err))
  })

  // Register mDNS service
  const bonjour = new Bonjour()
  bonjour.publish({
    name: `PhotoPeek-${folderName}`,
    type: 'photopeek',
    port: actualPort,
    txt: { eventId },
  })

  sessions.set(eventId, {
    eventId,
    port: actualPort,
    server,
    wss,
    users: new Map(),
    bonjour,
  })

  console.log(`[Share] Started sharing event ${eventId} (${folderName}) on port ${actualPort}`)

  return { port: actualPort, ips: getLocalIPs(), url: `http://${getLocalIPs()[0] || 'localhost'}:${actualPort}` }
}

export function stopShare(eventId: string): void {
  // Auto-stop tunnel if active
  stopTunnel(eventId)

  const session = sessions.get(eventId)
  if (!session) return

  // Notify all web users that sharing stopped
  broadcastUsers(session, { type: 'shutdown', reason: 'Host stopped sharing' })

  try { session.wss.close() } catch {}
  try { session.server.close() } catch {}
  if (session.bonjour) try { session.bonjour.destroy() } catch {}
  sessions.delete(eventId)

  // Notify renderer
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('share:users-update', { eventId, users: [] })
  }

  console.log(`[Share] Stopped sharing event ${eventId}`)
}

export function stopAllShares(): void {
  for (const eventId of sessions.keys()) {
    stopShare(eventId)
  }
}

export function getShareStatus(eventId: string): {
  active: boolean
  port?: number
  ips?: string[]
  url?: string
  users?: { id: string; nickname: string; joinedAt: string }[]
  tunnel?: { active: boolean; url?: string }
} {
  const session = sessions.get(eventId)
  if (!session) return { active: false }
  const userList = Array.from(session.users.values()).map(u => ({
    id: u.id,
    nickname: u.nickname,
    joinedAt: u.joinedAt,
  }))
  const tunnelInfo = tunnels.get(eventId)
  return {
    active: true,
    port: session.port,
    ips: getLocalIPs(),
    url: `http://${getLocalIPs()[0] || 'localhost'}:${session.port}`,
    users: userList,
    tunnel: tunnelInfo ? { active: true, url: tunnelInfo.url } : { active: false },
  }
}

// ─── Tunnel (Public via Cloudflare Tunnel) ─────────────────────────────────

function notifyRendererTunnelStatus(eventId: string): void {
  const tunnelInfo = tunnels.get(eventId)
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('share:tunnel-status', {
      eventId,
      active: !!tunnelInfo,
      url: tunnelInfo?.url,
    })
  }
}

export async function startTunnel(eventId: string): Promise<{ url: string }> {
  // Close existing tunnel if any
  stopTunnel(eventId)

  const session = sessions.get(eventId)
  if (!session) {
    throw new Error('共享未启动，请先启动局域网共享')
  }

  const port = session.port

  return new Promise<{ url: string }>((resolve, reject) => {
    const tunnel = Tunnel.quick(`http://localhost:${port}`)

    const timeout = setTimeout(() => {
      try { tunnel.stop() } catch {}
      reject(new Error('隧道连接超时，请检查网络'))
    }, 25000)

    tunnel.on('url', (url: string) => {
      clearTimeout(timeout)
      tunnels.set(eventId, { tunnel, url })
      notifyRendererTunnelStatus(eventId)
      console.log(`[Share] Tunnel started for ${eventId}: ${url}`)
      resolve({ url })
    })

    tunnel.on('error', (err: Error) => {
      clearTimeout(timeout)
      console.error(`[Share] Tunnel error for ${eventId}:`, err.message)
      // Don't reject here — the 'url' event may still come
    })

    tunnel.on('exit', (code: number | null) => {
      clearTimeout(timeout)
      // Clean up if tunnel exits unexpectedly
      if (tunnels.get(eventId)?.tunnel === tunnel) {
        tunnels.delete(eventId)
        notifyRendererTunnelStatus(eventId)
      }
      if (code !== 0) {
        reject(new Error(`cloudflared 进程退出 (code: ${code})`))
      }
    })
  })
}

export function stopTunnel(eventId: string): void {
  const existing = tunnels.get(eventId)
  if (!existing) return

  try {
    existing.tunnel.stop()
  } catch {}
  tunnels.delete(eventId)
  notifyRendererTunnelStatus(eventId)
  console.log(`[Share] Tunnel stopped for ${eventId}`)
}

export function getTunnelStatus(eventId: string): { active: boolean; url?: string } {
  const info = tunnels.get(eventId)
  return info ? { active: true, url: info.url } : { active: false }
}

// ─── WebSocket Message Handler ─────────────────────────────────────────────

function handleWsMessage(
  session: ShareSession,
  eventId: string,
  eventDir: string,
  ws: WebSocket,
  msg: any,
): void {
  switch (msg.type) {
    case 'join': {
      const nickname = (msg.userId || '').trim()
      if (!nickname) {
        wsSend(ws, { type: 'error', message: 'Nickname required' })
        return
      }

      // Generate unique ID for this connection
      const userId = nickname + '_' + Date.now()

      // Remove any existing connection with same socket
      for (const [uid, user] of session.users.entries()) {
        if (user.ws === ws) {
          session.users.delete(uid)
          break
        }
      }

      session.users.set(userId, {
        id: userId,
        nickname,
        joinedAt: new Date().toISOString(),
        ws,
      })

      // Welcome the new user
      wsSend(ws, { type: 'welcome', yourId: userId })

      // Send current event data
      const metaPath = path.join(eventDir, 'event.json')
      if (fs.existsSync(metaPath)) {
        wsSend(ws, {
          type: 'sync',
          payload: JSON.parse(fs.readFileSync(metaPath, 'utf-8')),
        })
      }

      // Broadcast updated user list to all
      const userList = Array.from(session.users.values()).map(u => ({
        id: u.id,
        nickname: u.nickname,
        joinedAt: u.joinedAt,
      }))
      broadcastUsers(session, { type: 'users', users: userList })

      // Notify desktop renderer
      notifyRendererUsers(session)
      break
    }

    case 'leave': {
      for (const [uid, user] of session.users.entries()) {
        if (user.ws === ws) {
          session.users.delete(uid)
          break
        }
      }
      const userList = Array.from(session.users.values()).map(u => ({
        id: u.id,
        nickname: u.nickname,
        joinedAt: u.joinedAt,
      }))
      broadcastUsers(session, { type: 'users', users: userList })
      notifyRendererUsers(session)
      break
    }

    case 'nicknameTagToggle': {
      // Double-click: toggle a tag named after the user's nickname
      let actingUser: WebUser | null = null
      for (const user of session.users.values()) {
        if (user.ws === ws) {
          actingUser = user
          break
        }
      }
      const nickname = actingUser?.nickname || msg.userId || 'Unknown'
      const photoId = msg.photoId
      if (!photoId) break

      const db = getDb()
      const existingTag = db.exec('SELECT id, name, color FROM tags WHERE event_id = ? AND name = ?', [eventId, nickname])
      let tagId: string

      if (existingTag.length > 0 && existingTag[0].values.length > 0) {
        tagId = existingTag[0].values[0][0] as string
      } else {
        // Create a new tag with the nickname as tag name
        tagId = uuid()
        const color = nicknameTagColor(nickname)
        const now = new Date().toISOString()
        db.run('INSERT OR IGNORE INTO tags (id, event_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
          [tagId, eventId, nickname, color, now])
      }

      // Toggle the tag on the photo
      const existing = db.exec('SELECT 1 FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [photoId, tagId])
      const has = existing.length > 0 && existing[0].values.length > 0

      if (has) {
        db.run('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [photoId, tagId])
      } else {
        db.run('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)', [photoId, tagId])
      }

      // Sync event.json
      syncEventJsonPhotos(eventId)

      // Read updated and broadcast
      const metaPath = path.join(eventDir, 'event.json')
      let updatedMeta: any = {}
      if (fs.existsSync(metaPath)) {
        updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      }
      broadcastUsers(session, { type: 'sync', payload: updatedMeta })

      const action = has ? 'removed' : 'added'
      notifyRendererTagAction(eventId, actingUser?.id || '', nickname, action, photoId, nickname)
      broadcastUsers(session, {
        type: 'tagAction',
        userId: actingUser?.id || '',
        nickname,
        action,
        photoId,
        tagName: nickname,
      })
      break
    }

    case 'tagToggle':
    case 'tagAdd':
    case 'tagRemove': {
      // Find the user who sent this
      let actingUser: WebUser | null = null
      for (const user of session.users.values()) {
        if (user.ws === ws) {
          actingUser = user
          break
        }
      }
      const nickname = actingUser?.nickname || msg.userId || 'Unknown'

      // Apply to local DB
      applyRemoteAction(eventId, msg)

      // Sync event.json
      syncEventJsonPhotos(eventId)

      // Read updated event.json
      const metaPath = path.join(eventDir, 'event.json')
      let updatedMeta: any = {}
      if (fs.existsSync(metaPath)) {
        updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      }

      // Broadcast full sync to ALL clients (including sender)
      broadcastUsers(session, { type: 'sync', payload: updatedMeta })

      // Also notify renderer with tag action detail
      const tagName = getTagNameFromId(msg.tagId)
      const action = msg.type === 'tagRemove' ? 'removed' : 'added'
      notifyRendererTagAction(eventId, actingUser?.id || '', nickname, action, msg.photoId, tagName)

      // Broadcast tag action toast to web clients
      broadcastUsers(session, {
        type: 'tagAction',
        userId: actingUser?.id || '',
        nickname,
        action,
        photoId: msg.photoId,
        tagName,
      })
      break
    }
  }
}

function getTagNameFromId(tagId: string): string {
  try {
    const db = getDb()
    const rows = db.exec('SELECT name FROM tags WHERE id = ?', [tagId])
    if (rows.length > 0 && rows[0].values.length > 0) {
      return (rows[0].values[0][0] as string) || tagId
    }
  } catch {}
  return tagId
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getEventFolderNameFromDb(eventId: string): string {
  const db = getDb()
  const rows = db.exec('SELECT folder_name FROM events WHERE id = ?', [eventId])
  if (rows.length > 0 && rows[0].values.length > 0) {
    return (rows[0].values[0][0] as string) || eventId
  }
  return eventId
}

function findFile(dir: string, name: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = findFile(fullPath, name)
        if (found) return found
      } else if (entry.name === name || entry.name.startsWith(name.split('.')[0])) {
        return fullPath
      }
    }
  } catch {}
  return null
}

/** Find a file by exact filename within a directory recursively */
function findFileInDir(dir: string, fileName: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = findFileInDir(fullPath, fileName)
        if (found) return found
      } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
        return fullPath
      }
    }
  } catch {}
  return null
}

/** Generate a deterministic color from a nickname string */
function nicknameTagColor(nickname: string): string {
  let hash = 0
  for (let i = 0; i < nickname.length; i++) {
    hash = nickname.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue}, 55%, 55%)`
}

function applyRemoteAction(eventId: string, msg: any): void {
  const db = getDb()
  const now = new Date().toISOString()
  try {
    switch (msg.type) {
      case 'tagToggle': {
        const existing = db.exec('SELECT 1 FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [msg.photoId, msg.tagId])
        const has = existing.length > 0 && existing[0].values.length > 0
        if (has) {
          db.run('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?', [msg.photoId, msg.tagId])
        } else {
          db.run('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)', [msg.photoId, msg.tagId])
        }
        break
      }
      case 'tagAdd': {
        db.run('INSERT OR IGNORE INTO tags (id, event_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
          [msg.tag.id, eventId, msg.tag.name, msg.tag.color, now])
        break
      }
      case 'tagRemove': {
        db.run('DELETE FROM photo_tags WHERE tag_id = ?', [msg.tagId])
        db.run('DELETE FROM tags WHERE id = ?', [msg.tagId])
        break
      }
    }
  } catch (err) {
    console.error('[Share] Failed to apply remote action:', err)
  }
}

// ─── Simple ZIP generator (no external deps) ──────────────────────────────

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function writeLE(buf: Buffer, offset: number, value: number, bytes: number): void {
  for (let i = 0; i < bytes; i++) {
    buf[offset + i] = (value >> (i * 8)) & 0xFF
  }
}

function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const localHeaders: Buffer[] = []
  const centralHeaders: Buffer[] = []
  let dataOffset = 0

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8')
    const crc = crc32(f.data)
    const size = f.data.length

    // Local file header
    const local = Buffer.alloc(30 + nameBuf.length)
    writeLE(local, 0, 0x04034b50, 4)
    writeLE(local, 4, 20, 2)
    writeLE(local, 6, 0, 2)
    writeLE(local, 8, 0, 2)             // stored (no compression)
    writeLE(local, 10, 0, 2)
    writeLE(local, 12, 0, 2)
    writeLE(local, 14, crc, 4)
    writeLE(local, 18, size, 4)
    writeLE(local, 22, size, 4)
    writeLE(local, 26, nameBuf.length, 2)
    writeLE(local, 28, 0, 2)
    nameBuf.copy(local, 30)
    localHeaders.push(local, f.data)

    // Central directory header
    const central = Buffer.alloc(46 + nameBuf.length)
    writeLE(central, 0, 0x02014b50, 4)
    writeLE(central, 4, 20, 2)
    writeLE(central, 6, 20, 2)
    writeLE(central, 8, 0, 2)
    writeLE(central, 10, 0, 2)
    writeLE(central, 12, 0, 2)
    writeLE(central, 14, 0, 2)
    writeLE(central, 16, crc, 4)
    writeLE(central, 20, size, 4)
    writeLE(central, 24, size, 4)
    writeLE(central, 28, nameBuf.length, 2)
    writeLE(central, 30, 0, 2)
    writeLE(central, 32, 0, 2)
    writeLE(central, 34, 0, 2)
    writeLE(central, 36, 0, 2)
    writeLE(central, 38, 0, 4)
    writeLE(central, 42, dataOffset, 4)
    nameBuf.copy(central, 46)
    centralHeaders.push(central)
    dataOffset += local.length + size
  }

  const centralSize = centralHeaders.reduce((s, b) => s + b.length, 0)
  const localTotal = localHeaders.reduce((s, b) => s + b.length, 0)

  const eocd = Buffer.alloc(22)
  writeLE(eocd, 0, 0x06054b50, 4)
  writeLE(eocd, 4, 0, 2)
  writeLE(eocd, 6, 0, 2)
  writeLE(eocd, 8, files.length, 2)
  writeLE(eocd, 10, files.length, 2)
  writeLE(eocd, 12, centralSize, 4)
  writeLE(eocd, 16, localTotal, 4)
  writeLE(eocd, 20, 0, 2)

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd])
}

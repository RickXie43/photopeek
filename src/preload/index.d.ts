import { ElectronAPI } from '@electron-toolkit/preload'

interface ShareUser {
  id: string
  nickname: string
  joinedAt: string
}

interface TagActionEvent {
  eventId: string
  userId: string
  nickname: string
  action: 'added' | 'removed'
  photoId: string
  tagName: string
  timestamp: string
}

interface UsersUpdateEvent {
  eventId: string
  users: ShareUser[]
}

interface TunnelStatusEvent {
  eventId: string
  active: boolean
  url?: string
  status?: 'inactive' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
  statusText?: string
}

interface VersionAddedEvent {
  photoId: string
  versionId: string
  versionName: string
  uploadedBy: string
  timestamp: string
}

interface VersionDeletedEvent {
  photoId: string
  versionId: string
}

interface ShareApi {
  onUsersUpdate: (callback: (data: UsersUpdateEvent) => void) => () => void
  onTagAction: (callback: (data: TagActionEvent) => void) => () => void
  onTunnelStatus: (callback: (data: TunnelStatusEvent) => void) => () => void
  onVersionAdded: (callback: (data: VersionAddedEvent) => void) => () => void
  onVersionDeleted: (callback: (data: VersionDeletedEvent) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    shareApi: ShareApi
  }
}

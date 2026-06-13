export interface PhotoEvent {
  id: string
  name: string
  description: string
  folderName: string
  coverPhotoId: string | null
  photoCount: number
  createdAt: string
  updatedAt: string
}

export interface Photo {
  id: string
  eventId: string
  filePath: string
  fileName: string
  fileSize: number
  width: number
  height: number
  rating: number            // 0-5
  flag: 'pick' | 'reject' | null
  colorLabel: 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null
  isEdited: boolean
  needsEdit: boolean
  thumbnailPath: string | null
  metadata: PhotoMetadata | null
  originalMetadata: PhotoMetadata | null
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TrashPhoto extends Photo {
  eventName?: string
}

export interface PhotoMetadata {
  dateTimeOriginal?: string
  cameraMake?: string
  cameraModel?: string
  lensModel?: string
  focalLength?: string
  aperture?: string
  shutterSpeed?: string
  iso?: number
  gpsLatitude?: number
  gpsLongitude?: number
  gpsAltitude?: number
  orientation?: number
  imageWidth?: number
  imageHeight?: number
  fileType?: string
  [key: string]: unknown
}

export interface Tag {
  id: string
  eventId: string | null
  name: string
  color: string
  createdAt: string
}

export interface PhotoTag {
  photoId: string
  tagId: string
}

export type ViewMode = 'grid' | 'loupe' | 'compare' | 'survey'
export type KeyboardMode = 'vim' | 'macos' | 'custom'

export interface FilterOptions {
  ratingMin: number
  ratingMax: number
  flag: 'pick' | 'reject' | 'unflagged' | null
  colorLabel: string | null
  dateFrom: string | null
  dateTo: string | null
  cameraModel: string | null
  searchQuery: string
  needsEdit: boolean | null
  isEdited: boolean | null
}

export interface AppSettings {
  keyboardMode: KeyboardMode
  customShortcuts: Record<string, string>
  thumbnailSize: number
  sidebarWidth: number
  inspectorVisible: boolean
  language: string
}

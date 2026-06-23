import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface PhotoPeekConfig {
  libraryPath: string
  thumbnailSize: number
  autoSaveDb: boolean
  language: string
  nickname: string
}

const DEFAULT_CONFIG: PhotoPeekConfig = {
  libraryPath: path.join(os.homedir(), 'Pictures', 'PhotoPeek'),
  thumbnailSize: 200,
  autoSaveDb: true,
  language: 'zh-CN',
  nickname: '',
}

let _libraryPath: string = ''
let _config: PhotoPeekConfig = { ...DEFAULT_CONFIG }

export function getLibraryPath(): string {
  return _libraryPath
}

export function getConfig(): PhotoPeekConfig {
  return { ..._config }
}

export function getEventsDir(): string {
  return path.join(_libraryPath, 'events')
}

export function getThumbnailsDir(): string {
  return path.join(_libraryPath, 'thumbnails')
}

export function getDbPath(): string {
  return path.join(_libraryPath, 'photopeek.db')
}

/**
 * Get event directory path using a folder name (human-readable, e.g. "2026_06_马尔代夫")
 */
export function getEventDir(folderName: string): string {
  return path.join(getEventsDir(), folderName)
}

/**
 * Get thumbnail directory path for an event using its folder name
 */
export function getEventThumbnailsDir(folderName: string): string {
  return path.join(getThumbnailsDir(), folderName)
}

/**
 * Sanitize a string to be safe for use as a filesystem folder name.
 * Keeps Chinese/Unicode characters but removes illegal chars: \ / : * ? " < > |
 */
export function sanitizeFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

/**
 * Generate a human-readable folder name from event name + creation date.
 * Format: YYYY_MM_SanitizedEventName (e.g. "2026_06_马尔代夫")
 */
export function generateFolderName(eventName: string, createdAt: string = new Date().toISOString()): string {
  const date = new Date(createdAt)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const safeName = sanitizeFolderName(eventName) || 'Untitled'
  return `${year}_${month}_${safeName}`
}

/**
 * Ensure a folder name is unique within the events directory.
 * Appends a counter suffix if the folder already exists.
 */
export function ensureUniqueFolderName(baseName: string): string {
  let folderName = baseName
  let counter = 1
  while (fs.existsSync(getEventDir(folderName))) {
    folderName = `${baseName}_${counter}`
    counter++
  }
  return folderName
}

function getConfigPath(): string {
  return path.join(_libraryPath, 'config.json')
}

function loadConfig(): void {
  const configPath = getConfigPath()
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
      _config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
    } catch {
      _config = { ...DEFAULT_CONFIG }
    }
  } else {
    _config = { ...DEFAULT_CONFIG }
  }
  _libraryPath = _config.libraryPath
}

export function saveConfig(config: Partial<PhotoPeekConfig>): PhotoPeekConfig {
  _config = { ..._config, ...config }
  _libraryPath = _config.libraryPath
  const configPath = getConfigPath()
  try {
    fs.mkdirSync(_libraryPath, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(_config, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save config:', err)
  }
  return getConfig()
}

export function ensureLibraryStructure(): void {
  const dirs = [
    _libraryPath,
    getEventsDir(),
    getThumbnailsDir(),
  ]
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function initializeLibrary(): void {
  // Use app data path as fallback if Pictures doesn't exist
  const defaultPath = path.join(os.homedir(), 'Pictures', 'PhotoPeek')
  _libraryPath = defaultPath
  loadConfig()
  ensureLibraryStructure()
  console.log(`PhotoPeek library initialized at: ${_libraryPath}`)
}

export function updateLibraryPath(newPath: string): void {
  _libraryPath = newPath
  ensureLibraryStructure()
  saveConfig({ libraryPath: newPath })
}

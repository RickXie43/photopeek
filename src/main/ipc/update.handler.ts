import { ipcMain, shell } from 'electron'
import * as https from 'https'

const GITHUB_REPO = 'Rick/PhotoPeek'
const CURRENT_VERSION = 'v2.0.0'

export interface CheckUpdateResult {
  latestVersion: string
  downloadUrl: string
  hasUpdate: boolean
  error?: string
}

/**
 * Compare two semver strings (e.g. "v2.0.0" vs "v2.1.0").
 * Returns true if versionA < versionB.
 */
function semverLt(a: string, b: string): boolean {
  const stripV = (s: string): string => s.replace(/^v/i, '')
  const pa = stripV(a).split('.').map(Number)
  const pb = stripV(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na !== nb) return na < nb
  }
  return false
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'PhotoPeek' } }, (res) => {
      let data = ''
      res.on('data', (chunk: string) => (data += chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let msg = `请求失败 (HTTP ${res.statusCode})`
          try {
            const body = JSON.parse(data)
            if (body.message) msg += `: ${body.message}`
          } catch {}
          reject(new Error(msg))
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error('解析响应失败'))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
  })
}

/**
 * Fallback: follow the releases/latest redirect to extract version tag from URL.
 * Works when GitHub API is rate-limited or blocked.
 */
function fetchLatestVersionFromRedirect(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://github.com/${GITHUB_REPO}/releases/latest`,
      { headers: { 'User-Agent': 'PhotoPeek' }, timeout: 10000 },
      (res) => {
        // GitHub redirects to /releases/tag/vX.X.X, extract version from location header
        const location = res.headers.location || ''
        const match = location.match(/\/releases\/tag\/(v[\d.]+)/i)
        if (match) {
          resolve(match[1])
        } else {
          reject(new Error('无法从重定向中提取版本号'))
        }
      }
    )
    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('请求超时'))
    })
  })
}

export function registerUpdateHandlers(): void {
  ipcMain.handle('updates:checkLatest', async (): Promise<CheckUpdateResult> => {
    // Try primary: GitHub API
    try {
      const release = await fetchJson(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
      )
      const latestVersion: string = release.tag_name || ''
      const hasUpdate = latestVersion
        ? semverLt(CURRENT_VERSION, latestVersion)
        : false

      // Find the setup exe asset
      const assets: Array<{ name: string; browser_download_url: string }> =
        release.assets || []
      const setupAsset = assets.find(
        (a) => a.name.endsWith('-setup.exe') && !a.name.endsWith('.exe.blockmap')
      )
      const downloadUrl = setupAsset?.browser_download_url || ''

      return { latestVersion, downloadUrl, hasUpdate }
    } catch {
      // Fallback: follow the releases/latest redirect to extract version from URL
      try {
        const version = await fetchLatestVersionFromRedirect()
        if (version) {
          return {
            latestVersion: version,
            downloadUrl: '',
            hasUpdate: semverLt(CURRENT_VERSION, version),
          }
        }
      } catch {}
      return {
        latestVersion: '',
        downloadUrl: '',
        hasUpdate: false,
        error: '检查更新失败，请确认网络可访问 github.com',
      }
    }
  })

  ipcMain.handle(
    'updates:openDownloadPage',
    async (_event, downloadUrl: string): Promise<void> => {
      const url =
        downloadUrl ||
        `https://github.com/${GITHUB_REPO}/releases/latest`
      await shell.openExternal(url)
    }
  )
}

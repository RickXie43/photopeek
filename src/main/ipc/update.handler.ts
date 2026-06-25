import { app, ipcMain, shell } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

const GITHUB_REPO = 'Rick/PhotoPeek'
const GITEE_OWNER = 'RickXie43'
const GITEE_REPO = 'photopeek'
const GITEE_VERSION_URL = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/raw/master/version.json`
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

function fetchJson(url: string, maxRedirects = 3): Promise<any> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('重定向次数过多'))
      return
    }
    const req = https.get(url, { headers: { 'User-Agent': 'PhotoPeek' } }, (res) => {
      // Follow redirects (e.g. Gitee raw -> CDN)
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume() // drain response
        resolve(fetchJson(res.headers.location, maxRedirects - 1))
        return
      }
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

/**
 * Fetch version info from Gitee version.json (国内源，速度快)
 */
async function fetchVersionFromGitee(): Promise<{
  latestVersion: string
  downloadUrl: string
}> {
  const data = await fetchJson(GITEE_VERSION_URL)
  const latestVersion: string = data?.latestVersion || ''
  const downloadUrl: string = data?.downloadUrl || ''
  if (!latestVersion) throw new Error('Gitee version.json 中缺少 latestVersion')
  return { latestVersion, downloadUrl }
}

export function registerUpdateHandlers(): void {
  ipcMain.handle('updates:checkLatest', async (): Promise<CheckUpdateResult> => {
    const errors: string[] = []

    // 1. Try Gitee (国内源，速度快)
    try {
      const { latestVersion, downloadUrl } = await fetchVersionFromGitee()
      return {
        latestVersion,
        downloadUrl,
        hasUpdate: semverLt(CURRENT_VERSION, latestVersion),
      }
    } catch (e) {
      errors.push(`Gitee: ${(e as Error).message}`)
    }

    // 2. Fallback: GitHub API
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
    } catch (e) {
      errors.push(`GitHub API: ${(e as Error).message}`)
    }

    // 3. Last resort: GitHub releases/latest redirect
    try {
      const version = await fetchLatestVersionFromRedirect()
      if (version) {
        return {
          latestVersion: version,
          downloadUrl: '',
          hasUpdate: semverLt(CURRENT_VERSION, version),
        }
      }
    } catch (e) {
      errors.push(`GitHub redirect: ${(e as Error).message}`)
    }

    return {
      latestVersion: '',
      downloadUrl: '',
      hasUpdate: false,
      error: `检查更新失败: ${errors.join('; ')}`,
    }
  })

  /**
   * Download a file from url to destination path.
   */
  ipcMain.handle(
    'updates:openDownloadPage',
    async (_event, downloadUrl: string): Promise<void> => {
      const url =
        downloadUrl ||
        `https://github.com/${GITHUB_REPO}/releases/latest`
      await shell.openExternal(url)
    }
  )

  /**
   * Download installer and perform silent install.
   */
  ipcMain.handle(
    'updates:downloadAndInstall',
    async (
      _event,
      downloadUrl: string
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const tempDir = app.getPath('temp')
        const installerName = `photopeek-setup-${Date.now()}.exe`
        const installerPath = path.join(tempDir, installerName)

        // Download installer
        await downloadFile(downloadUrl, installerPath)

        // Create batch script to wait for app exit then run installer silently
        const batPath = path.join(tempDir, `photopeek-update-${Date.now()}.bat`)
        const batContent = [
          '@echo off',
          '',
          ':wait',
          'tasklist /FI "IMAGENAME eq photopeek.exe" 2^>NUL | find /I "photopeek.exe" >NUL',
          'if %ERRORLEVEL% EQU 0 (',
          '  timeout /T 1 /NOBREAK >NUL',
          '  goto wait',
          ')',
          '',
          `start /wait "" "${installerPath}" /S`,
          `del "${installerPath}"`,
          `del "%~f0"`,
        ].join('\r\n')
        fs.writeFileSync(batPath, batContent, 'utf-8')

        // Spawn batch script detached so it survives app exit
        const child = spawn(batPath, [], {
          detached: true,
          stdio: 'ignore',
          shell: true,
          windowsHide: true,
        })
        child.unref()

        // Quit the app — the batch script will wait until we're fully gone
        setImmediate(() => {
          app.exit()
        })

        return { success: true }
      } catch (e) {
        return { success: false, error: (e as Error).message }
      }
    }
  )
}

/**
 * Download a file from a URL to a local destination path.
 * Follows HTTP redirects (e.g. Gitee raw -> CDN).
 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.get(url, { headers: { 'User-Agent': 'PhotoPeek' } }, (res) => {
      // Follow redirects
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume()
        file.close()
        fs.unlink(dest, () => {})
        resolve(downloadFile(res.headers.location as string, dest))
        return
      }
      if (res.statusCode !== 200) {
        file.close()
        fs.unlink(dest, () => {})
        reject(new Error(`下载失败 (HTTP ${res.statusCode})`))
        return
      }
      res.pipe(file)
      file.on('finish', () => {
        file.close()
        resolve()
      })
    })
    req.on('error', (err) => {
      file.close()
      fs.unlink(dest, () => {})
      reject(err)
    })
    req.setTimeout(60000, () => {
      req.destroy()
      file.close()
      fs.unlink(dest, () => {})
      reject(new Error('下载超时'))
    })
  })
}

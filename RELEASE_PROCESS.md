# PhotoPeek 发布流程

当前发布版本以 `package.json` 的 `version` 为唯一版本来源。发布产物统一放在 `dist/<version>/`，每个版本目录只保留三个面向用户的文件：

- `photopeek-<version>-win-x64.zip`：Windows x64 便携版
- `photopeek-<version>-win-x64-setup.exe`：Windows x64 安装版（IExpress，自解压 ZIP，不依赖 NSIS/nsisunz）
- `photopeek-<version>-mac-arm64.zip`：macOS Apple Silicon（M 系列）版

当用户说“更新版本，生成新的发布”时：

1. 读取 `package.json` 版本并递增补丁号（除非用户指定版本号），同步 `package-lock.json` 根版本。
2. 执行 `npm run typecheck`、`npm run build:win`，生成 Windows x64 ZIP。
3. 执行 `scripts/build-iexpress-installer.ps1`，生成同版本 Windows x64 安装包。
4. 在 M 系列 Mac 或 GitHub Actions macOS runner 上执行 `npm run build:mac-arm64`，将 Apple Silicon ZIP 放入 `dist/<version>/`；Windows 环境无法完成时明确告知用户，不能把发布标记为完整。
5. 确认 `dist/<version>/` 中有以上三个文件后，重新生成 `SHA256SUMS.txt`，确保清单包含全部三个成品。历史版本目录保留原位，不自动覆盖或删除。

上述步骤也可以在版本号已更新后，在 Windows 上执行 `powershell -File scripts/release.ps1 -SkipMac`。此脚本只生成并整理两个 Windows 成品及当时可用产物的哈希；待 macOS runner 完成第三个包后，将其放入同一版本目录并重新生成完整哈希清单。它不会自动归档历史版本。

安装包使用 IExpress + PowerShell 解压 ZIP，避免旧版 NSIS 解压插件导致的 `fail to decompress file`。

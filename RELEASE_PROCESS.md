# PhotoPeek 发布流程

正式发布由 `.github/workflows/release.yml` 完成。`dist/` 保持在 Git 忽略列表中：源码提交和版本标签触发云端构建，GitHub Actions 将各平台产物暂存并在所有检查通过后一起添加到同一个 GitHub Release。

## 本次发布的文件

- `photopeek-<version>-win-x64.zip`：Windows x64 便携版
- `photopeek-<version>-win-x64-setup.exe`：Windows x64 IExpress 安装包
- `photopeek-<version>-mac-arm64.zip`：Apple Silicon macOS 便携版
- `photopeek-<version>.dmg`：Apple Silicon macOS 安装映像
- `SHA256SUMS.txt`：以上四个文件的 SHA-256 校验值

Windows 在 `windows-2022` runner 上构建，macOS 在 Apple Silicon `macos-15` runner 上构建。两个平台均先运行 `npm run test:tags`，再编译程序。发布任务依赖两个构建任务，逐个检查文件存在后创建包含全部附件的草稿 Release，再将其发布。任意平台失败或附件缺失时，发布任务不会执行；若发布过程本身失败，草稿会留在 GitHub 供排查。

## 发布新版本

1. 更新 `package.json` 和 `package-lock.json` 的版本号，保持一致。
2. 提交改动并推送到 GitHub。
3. 编写 `RELEASE_v<version>.md` 发布说明，在该提交上创建并推送对应标签，例如 `v2.0.6`。标签必须与两个版本文件一致。
4. 在 GitHub 仓库的 **Actions → Build and publish release** 查看运行结果。全部成功后，GitHub Release 会自动公开并包含上述五个文件。

也可从 **Actions → Build and publish release → Run workflow** 手动运行已有标签。手动运行不会创建标签；标签必须已推送到仓库，且其版本要与 `package.json` 相符。

## 首次配置与排错

- 工作流使用仓库自带的 `GITHUB_TOKEN` 和 `contents: write` 权限创建并发布 Release，无需另外配置 GitHub token。
- `.github/workflows/sync-gitee.yml` 仍由 Release 发布事件触发；若仓库配置了 `GITEE_TOKEN` 与 `GITEE_OWNER`，它会继续同步 Gitee 的 `version.json`。
- 检查失败时先查看对应平台构建日志。Release 草稿如果已经创建，修复问题后重新运行工作流；相同标签的运行会更新草稿并补齐附件。
- macOS 包当前未配置 Developer ID 签名或 notarization，首次打开时 macOS 可能提示无法验证开发者身份。

## 本地调试

可分别运行 `npm run build:win`、`npm run build:mac-arm64`、`npm run build:mac-dmg` 验证本机平台构建。Windows 安装包由 `scripts/build-iexpress-installer.ps1` 根据 Windows ZIP 生成。不要将 `dist/` 提交到 Git；正式发布以 GitHub Actions 的同标签构建结果为准。

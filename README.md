# PhotoPeek 📸

> `v2.0.0` — [GitHub](https://github.com/Rick/PhotoPeek) | 基于 Electron 的本地照片管理与共享应用。导入照片、创建事件、打标签、在局域网或公网中实时共享浏览。

## 功能特性

- **事件管理** — 以事件（文件夹）为单位组织照片，支持创建、重命名、删除
- **照片导入** — 从文件夹批量导入照片，自动读取 EXIF 元数据（拍摄日期、相机型号等）
- **多版本管理** — 同一照片支持多个版本（RAW + JPEG 自动合并、上传编辑版本），桌面端与 Web 端均支持版本对比（并排/滑动/切换）
- **快速浏览** — 虚拟网格（react-virtuoso）流畅浏览大量照片，支持 Loupe 大图预览
- **标签系统** — 为照片添加彩色标签，支持按标签筛选
- **缩略图缓存** — 自动生成并缓存缩略图，加速浏览
- **回收站** — 软删除照片，可恢复或永久清空
- **局域网共享** — 一键启动 HTTP + WebSocket 共享，同网络设备浏览器即可查看
- **公网共享** — 通过 Cloudflare Tunnel 生成公网 HTTPS 地址，无需端口转发，任意网络均可访问
- **实时协作** — 访客可加标签、标记本人标签，操作实时同步到所有连接设备
- **智能画质** — Web 端大图默认加载中图（1200px / JPEG 80 品质），点击「加载原图」才加载全分辨率，并显示进度百分比
- **打包下载** — Web 端一键打包下载原图为 ZIP

## 使用说明

### 导入照片

1. 点击工具栏 **导入** 按钮，选择包含照片的文件夹
2. 选择目标事件（或创建新事件）
3. 预览待导入文件列表，点击 **开始导入**
4. 应用会自动复制文件、解析 EXIF、生成缩略图

### 浏览照片

- **网格视图** — 默认视图，以缩略图网格展示事件内所有照片
- **大图预览 (Loupe)** — 双击照片或按 `Enter` 进入大图模式
  - `←` `→` / `j` `k` — 切换上一张/下一张
  - `Esc` — 退出大图
  - `Space` — 标记/取消标记"本人标签"
- **多版本管理** — Loupe 大图模式下右侧版本面板支持：
  - 查看照片所有版本（RAW、相机 JPEG、编辑版等）
  - 勾选多个版本进行**并排对比**、**滑动对比** 或 **切换对比**
  - 上传新版本（自动以 `昵称_序号` 命名）
  - 从 Web 端下载单个版本原图
- **照片评级** — 在大图模式下按 `1`-`5` 数字键快速评级

### 标签管理

- 在照片上右键或使用 Inspector 面板添加/移除标签
- 标签支持自定义名称和颜色
- 侧边栏标签列表：点击标签筛选照片，右键标签可编辑或删除

### 局域网共享

1. 点击工具栏 **共享** 按钮，选择要共享的事件
2. 点击 **开始共享**
3. 同局域网内的设备浏览器访问显示的地址即可进入 Web 查看页
4. 手机扫描二维码也可快速进入

### 公网共享（通过 Cloudflare Tunnel）

> 无需路由器端口转发，无需公网 IP

1. 先**启动局域网共享**
2. 在共享信息卡片中点击 **🌐 开启公网共享**
3. 等待几秒，生成 `https://xxxxx.trycloudflare.com` 公网地址
4. 任意网络环境的设备访问该地址即可浏览照片
5. 访客双击照片可加标签，操作实时同步

### Web 端浏览功能

共享打开后，手机/电脑浏览器访问地址即可使用以下功能：

- **照片网格** — 缩略图网格浏览，可调节缩略图大小
- **大图预览** — 点击照片进入大图模式，键盘 `←` `→` / `j` `k` 切换
- **多版本对比** — 右侧版本面板勾选多版本，支持**并排对比**、**滑动对比**（拖拽分割线）和**点击切换**三种模式
- **版本上传** — 在浏览器中直接上传编辑后的版本，自动同步到桌面端
- **三档画质** — 大图默认加载**中图**（1200px / JPEG 80 品质），点击「加载原图」按钮才加载全分辨率原图，加载时显示百分比进度
- **标签过滤** — 按标签筛选照片
- **双击标记** — 双击照片快速添加/移除本人昵称标签
- **打包下载** — 一键打包下载所有照片为 ZIP
- **实时动态** — 其他访客的打标签操作实时显示

> ⚠️ TryCloudflare 快速隧道依赖 Cloudflare 基础设施，部分地区可能较慢。
> 如果速度不理想，可尝试自建 tunnel 服务器或使用 [bore](https://github.com/ekzhang/bore) 等替代方案。

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Enter` 或双击 | 进入大图预览 |
| `Esc` | 退出大图 |
| `←` / `→` 或 `k` / `j` | 切换照片 |
| `Space` | 标记/取消标记本人昵称标签 |
| `1`-`5` | 照片评级 |
| `Delete` | 删除照片（软删除） |
| `h` / `l`（Web 大图） | 切换上一张/下一张照片 |
| `j` / `k`（Web 大图） | 循环切换当前照片的版本 |

## 桌面端快捷键

| 快捷键 | 功能 |
|--------|------|
| `j` / `k` | Loupe 模式下切换照片 |
| `h` / `l` | Loupe 模式下切换上一张/下一张 |

## 技术栈

| 层 | 技术 |
|------|--------|
| 框架 | Electron 39 + React 19 + TypeScript |
| 构建 | electron-vite + electron-builder |
| 样式 | Tailwind CSS 4 |
| 状态管理 | Zustand |
| 数据库 | SQLite (sql.js WASM) |
| 虚拟网格 | react-virtuoso (VirtuosoGrid) |
| 图标 | lucide-react |
| 图片处理 | sharp (缩略图) + exifr (EXIF) |
| 局域网共享 | HTTP + WebSocket + Bonjour (mDNS) |
| 公网隧道 | Cloudflare Tunnel (cloudflared) |

## 项目设置

### 环境要求

- Node.js >= 20
- pnpm（推荐）或 npm

### 安装依赖

```bash
pnpm install
```

> 注意：`cloudflared` 包需要在安装时下载二进制文件，请确保网络通畅。如遇 `pnpm` 拦截构建脚本，运行 `pnpm approve-builds cloudflared`。

### 开发运行（不编译，热更新）

```bash
# 启动开发模式（支持热更新，修改代码自动刷新）
pnpm run dev
```

开发模式下会启动 Electron 窗口+ Vite 开发服务器，代码修改后自动热更新，适合日常开发调试。

### 生产构建

```bash
# 仅编译（生成 out/ 目录，不打包安装包）
pnpm run build

# 编译并打包为安装包（各平台）
pnpm run build:win     # Windows (NSIS 安装程序 .exe)
pnpm run build:mac     # macOS (DMG 安装包 .dmg)
pnpm run build:linux   # Linux (AppImage / snap / deb)
```

各平台构建产物输出在 `dist/` 目录：

| 命令 | 输出文件 | 说明 |
|------|---------|------|
| `build:win` | `dist/photopeek-*-setup.exe` | Windows 安装程序 |
| `build:mac` | `dist/photopeek-*.dmg` | macOS DMG 镜像 |
| `build:linux` | `dist/photopeek-*.AppImage` | Linux AppImage 便携版 |

> Windows 构建所需 Electron 二进制已配置为使用本地 `node_modules/electron/dist`，无需从网络下载。

### 推荐开发工具

- [VS Code](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

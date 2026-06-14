# PhotoPeek 📸

一款基于 Electron 的本地照片管理与共享应用。导入照片、创建事件、打标签、在局域网或公网中实时共享浏览。

## 功能特性

- **事件管理** — 以事件（文件夹）为单位组织照片，支持创建、重命名、删除
- **照片导入** — 从文件夹批量导入照片，自动读取 EXIF 元数据（拍摄日期、相机型号等）
- **快速浏览** — 虚拟网格（react-virtuoso）流畅浏览大量照片，支持 Loupe 大图预览
- **标签系统** — 为照片添加彩色标签，支持按标签筛选
- **缩略图缓存** — 自动生成并缓存缩略图，加速浏览
- **回收站** — 软删除照片，可恢复或永久清空
- **局域网共享** — 一键启动 HTTP + WebSocket 共享，同网络设备浏览器即可查看
- **公网共享** — 通过 Cloudflare Tunnel 生成公网 HTTPS 地址，无需端口转发，任意网络均可访问
- **实时协作** — 访客可加标签、标记本人标签，操作实时同步到所有连接设备

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

### 启动开发模式

```bash
pnpm run dev
```

### 项目构建

```bash
# 类型检查 + Vite 编译
pnpm run build

# 打包为 Windows 安装程序
pnpm run build:win

# 打包为 macOS DMG
pnpm run build:mac

# 打包为 Linux (AppImage / snap / deb)
pnpm run build:linux
```

### 推荐开发工具

- [VS Code](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

# v2.0.1 — 稳定性修复与对话框焦点改进

PhotoPeek v2.0.1 主要修复删除事件后对话框输入框无法聚焦的关键 Bug，并优化缓存清理体验。

---

## 🐛 Bug 修复

### 对话框焦点修复

- **删除事件后对话框无法输入** — 根因是 `window.confirm()` 浏览器原生阻塞对话框关闭后，浏览器焦点恢复机制与 React 的 `autoFocus` 冲突，导致后续弹出对话框的输入框无法聚焦。
  - 创建自定义 `ConfirmDialog` 组件（React 模态框），完全替代 `window.confirm()`
  - 通过全局 ref 模式实现 `await confirm({...})` 异步调用，保持代码简洁
  - 新建事件对话框增加多重焦点重试策略（0 / 50 / 150 / 400ms）+ 点击空白区域自动聚焦
  - 清除 `useKeyboard` 中不必要的依赖项，避免事件删除时键盘监听器反复重新注册

### 缓存管理增强

- **清除数据后彻底重启** — 替换 `window.confirm()` 为自定义对话框
- 清除确认文案增加"清除后将重启软件"提示
- 清除成功后调用 `app.relaunch()` + `app.quit()` 彻底重启应用而非仅刷新页面

### 其他

- 修复 TypeScript 编译中的未使用变量警告（`import.handler.ts`、`photo.handler.ts`）

---

## 🔧 技术改进

| 改动 | 文件 |
|------|------|
| 自定义确认对话框组件 | `src/renderer/src/components/ui/ConfirmDialog.tsx` |
| 异步 confirm 函数模式 | 全局 ref + Promise |
| 焦点多重重试机制 | `CreateEventDialog.tsx` |
| 应用重启 IPC | `src/main/index.ts` — `app:restart` |

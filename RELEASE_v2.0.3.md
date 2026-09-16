# PhotoPeek v2.0.3

## 发布内容

- 修复切换数据文件夹后热加载、缩略图自动补生成与大图显示。
- 修复弹窗必须点击关闭按钮才能关闭的问题。
- 增加事件导出/导入及 `event.json` 元数据校验与版本顺序保留。
- 发布目录统一为 `dist/2.0.3/`；Windows x64 便携版和安装版已生成。macOS Apple Silicon 包需在 macOS runner 上执行 `npm run build:mac-arm64` 后放入同目录。

详见 [RELEASE_PROCESS.md](./RELEASE_PROCESS.md)。

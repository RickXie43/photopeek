# PhotoPeek 项目指令

## 关键规则：全局键盘事件处理

本应用使用 `useKeyboard` hook（`src/renderer/src/hooks/useKeyboard.ts`）在 `window` 上注册全局 `keydown` 事件监听器。

### 在修改或新增全局键盘处理器时必须遵守：

1. **所有全局 `keydown` 监听器**（无论注册在 `window`、`document` 还是其他元素上）**必须在处理任何快捷键逻辑之前检查当前焦点是否在输入控件中**。

2. 输入控件检查代码模板（必须放在处理器最顶部）：
   ```typescript
   const target = e.target as HTMLElement
   const activeEl = document.activeElement as HTMLElement | null
   const isInput = (el: HTMLElement | null): boolean =>
     el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
   if (isInput(target) || isInput(activeEl)) return
   ```

3. **不得删除或绕过该输入检查**。如果需要新增全局快捷键，请在现有检查之后添加逻辑。

4. 对于对话框内的输入框，可使用 `e.stopPropagation()` 阻止事件冒泡到全局处理器，但不应依赖此方式替代第2条的检查。

### 为什么这是关键规则

- 用户无法在对话框（创建事件、导入、设置等）的输入框中输入文字
- 此问题曾多次发生（因 `keyboardMode` 引用未定义、因删除输入检查等），属于高频复现 bug
- 任何修改 `useKeyboard.ts` 的 PR 必须确保输入控件检查完整无缺

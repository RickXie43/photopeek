---
applyTo: "src/**/*.{ts,tsx}"
---

# TypeScript 开发规范（PhotoPeek）

## 1. 类型优先

### 1.1 优先使用 `type` 而非 `interface`

```typescript
// ✅ 推荐
type Photo = {
  id: number
  filename: string
  rating: number
}

// ❌ 不推荐（除非需要 declaration merging）
interface Photo {
  id: number
  filename: string
  rating: number
}
```

**原因：** `type` 更一致——联合类型、交叉类型、元组都用 `type`。`interface` 只在需要 `declaration merging`（如扩展第三方类型）时使用。

### 1.2 总是显式定义 Props 类型

```typescript
// ✅ 推荐
type PhotoThumbnailProps = {
  photo: Photo
  selected: boolean
  onSelect: (id: number) => void
}

const PhotoThumbnail = ({ photo, selected, onSelect }: PhotoThumbnailProps) => { ... }

// ❌ 不推荐（用 React.FC 有各种问题）
const PhotoThumbnail: React.FC<{ photo: Photo; selected: boolean }> = (props) => { ... }
```

### 1.3 优先用 `interface` 扩展第三方库类型

```typescript
// ✅ 当需要扩展 Window/全局类型时用 interface（declaration merging）
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
```

## 2. 类型推断 vs 显式类型

### 2.1 简单类型让 TS 推断

```typescript
// ✅ 推荐 — 类型明显，让 TS 推断
const [selectedId, setSelectedId] = useState<number | null>(null)
const items = photos.filter(p => p.rating > 3)

// ❌ 多余
const [selectedId, setSelectedId] = useState<number | null>(null as number | null)
const items: Photo[] = photos.filter(p => p.rating > 3)
```

### 2.2 函数返回值总是显式标注

```typescript
// ✅ 推荐 — 函数返回类型显式标注，自文档化
const getFilteredPhotos = (tag: string): Photo[] => {
  return photos.filter(p => p.tags.includes(tag))
}

// ❌ 不推荐 — 依赖推断，读代码的人不知道返回什么
const getFilteredPhotos = (tag: string) => {
  return photos.filter(p => p.tags.includes(tag))
}
```

### 2.3 回调参数类型可推断时可省略

```typescript
// ✅ 推荐
photos.map((p) => p.filename)

// 只有当回调复杂时才标注
photos.map((p: Photo): string => {
  return `${p.filename} (${p.rating})`
})
```

## 3. 严格模式写法（已开启 `strict: true`）

### 3.1 处理 `null`/`undefined`

```typescript
// ✅ 推荐 — 用可选链
const name = photo?.metadata?.camera ?? '未知'

// ✅ 推荐 — 提前 return 消除 null
const renderPhoto = (photo: Photo | null): JSX.Element | null => {
  if (!photo) return null
  return <div>{photo.filename}</div>
}

// ❌ 不推荐 — 非空断言可能运行时崩溃
const name = photo!.metadata!.camera!
```

### 3.2 `unknown` vs `any`

```typescript
// ✅ 推荐 — 用 unknown + 类型守卫
const parseData = (data: unknown): string => {
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null && 'name' in data) {
    return String((data as Record<string, unknown>).name)
  }
  return ''
}

// ❌ 不推荐 — any 会关闭所有类型检查
const parseData = (data: any): string => data.name ?? ''
```

## 4. 项目特有类型模式

### 4.1 Zustand Store 类型

```typescript
// ✅ 推荐 — store 类型集中定义
type PhotoStore = {
  photos: Photo[]
  selectedId: number | null
  loading: boolean
  // actions
  fetchPhotos: (eventId: number) => Promise<void>
  setRating: (photoId: number, rating: number) => void
}

const usePhotoStore = create<PhotoStore>()((set) => ({
  photos: [],
  selectedId: null,
  loading: false,
  fetchPhotos: async (eventId) => { ... },
  setRating: (photoId, rating) => set((state) => ({
    photos: state.photos.map(p => p.id === photoId ? { ...p, rating } : p)
  })),
}))
```

### 4.2 Electron IPC 类型安全（preload）

```typescript
// preload/index.d.ts — 类型定义
type PhotoAPI = {
  list: (eventId: number) => Promise<Photo[]>
  updateRating: (photoId: number, rating: number) => Promise<void>
  delete: (photoId: number) => Promise<void>
}

// 渲染进程通过 window.electronAPI 使用
const photos = await window.electronAPI.photo.list(eventId)
```

### 4.3 事件/联合类型

```typescript
// ✅ 推荐 — 用 discriminated union 表达不同状态
type ViewMode = 'grid' | 'loupe'

type ImportStatus =
  | { type: 'idle' }
  | { type: 'scanning'; progress: number }
  | { type: 'importing'; current: string; total: number }
  | { type: 'done'; imported: number }
  | { type: 'error'; message: string }

// 使用时通过 switch 穷举
const renderStatus = (status: ImportStatus): string => {
  switch (status.type) {
    case 'idle': return '就绪'
    case 'scanning': return `扫描中 ${status.progress}%`
    case 'importing': return `导入中 ${status.current} (${status.total})`
    case 'done': return `完成，共导入 ${status.imported} 张`
    case 'error': return `错误: ${status.message}`
  }
}
```

## 5. React + TypeScript 最佳实践

### 5.1 事件处理函数类型

```typescript
// ✅ 推荐
const handleClick = (e: React.MouseEvent<HTMLButtonElement>): void => {
  e.stopPropagation()
  // ...
}

const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
  setValue(e.target.value)
}

// ❌ 不推荐
const handleClick = (e: any) => { ... }
```

### 5.2 `useRef` 类型

```typescript
// ✅ 推荐
const dialogRef = useRef<HTMLDialogElement>(null)
// 注意：访问时仍需 null 检查
dialogRef.current?.showModal()

const inputRef = useRef<HTMLInputElement>(null)
inputRef.current?.focus()
```

### 5.3 `useEffect` 中的异步

```typescript
// ✅ 推荐
useEffect(() => {
  const fetchData = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await api.fetchPhotos(eventId)
      setPhotos(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }
  fetchData()
}, [eventId])

// ❌ 不推荐 — useEffect 不接受 async 函数直接作为回调
useEffect(async () => { ... }, [])
```

## 6. 代码组织与可读性

### 6.1 导入顺序

```typescript
// 1. 外部依赖（npm 包）
import { useState, useEffect } from 'react'
import { create } from 'zustand'
import { ArrowLeft, ArrowRight } from 'lucide-react'

// 2. 内部模块（相对路径）
import { Photo } from '@renderer/types/photo'
import { usePhotoStore } from '@renderer/stores/photoStore'

// 3. 样式/CSS
import './styles.css'
```

### 6.2 泛型命名约定

```typescript
// ✅ 推荐 — 单字母泛型用于简单场景
function identity<T>(value: T): T

// 复杂场景用描述性名称
function createStore<TState, TActions>(): Store<TState, TActions>
```

### 6.3 避免过度抽象

```typescript
// ✅ 推荐 — 简单直接
const isPhoto = (obj: unknown): obj is Photo => {
  return typeof obj === 'object' && obj !== null && 'id' in obj
}

// ❌ 不推荐 — 过度泛型化
const isTypeOf = <T extends Record<string, unknown>>(obj: unknown, keys: (keyof T)[]): obj is T => {
  return typeof obj === 'object' && obj !== null && keys.every(k => k in obj)
}
```

## 7. 常见陷阱

### 7.1 不要用 `{}` 作为类型

```typescript
// ❌ 不推荐 — {} 表示"非 null 非 undefined 的任何值"
const process = (item: {}) => { ... }

// ✅ 推荐 — 明确表达意图
const process = (item: Record<string, unknown>) => { ... }
// 或
const process = (item: unknown) => { ... }
```

### 7.2 数组类型一致性

```typescript
// ✅ 推荐 — 选一种保持一致
type PhotoList = Photo[]    // 风格 A：语法糖
// type PhotoList = Array<Photo>  // 风格 B：泛型（JSX 中避免）

// 混合类型数组
type Item = (Photo | Event)[]
```

### 7.3 枚举用 `as const` + union 替代

```typescript
// ✅ 推荐 — 更安全，tree-shaking 友好
const ViewModes = ['grid', 'loupe'] as const
type ViewMode = (typeof ViewModes)[number]
// ViewMode = 'grid' | 'loupe'

// ❌ 不推荐 — 运行时开销，反向映射有隐患
enum ViewMode { Grid = 'grid', Loupe = 'loupe' }
```

## 8. 调试与工具

- 遇到类型报错，先 hover 看推断类型
- 用 `satisfies` 关键字（TS 4.9+）验证类型但不改变推断：
  ```typescript
  const config = {
    viewMode: 'grid',
    pageSize: 50
  } satisfies Record<string, unknown>
  ```
- 用 ` satisfies ` 替代显式类型标注来保持最精确的推断

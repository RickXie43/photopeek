import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ViewMode, KeyboardMode, FilterOptions, AppSettings } from '../types/photo'

interface UIStore {
  viewMode: ViewMode
  keyboardMode: KeyboardMode
  filterOptions: FilterOptions
  inspectorVisible: boolean
  thumbnailSize: number
  importDialogOpen: boolean
  createEventDialogOpen: boolean
  settingsDialogOpen: boolean
  showingTrash: boolean

  setViewMode: (mode: ViewMode) => void
  setKeyboardMode: (mode: KeyboardMode) => void
  setFilterOptions: (options: Partial<FilterOptions>) => void
  resetFilter: () => void
  toggleInspector: () => void
  setThumbnailSize: (size: number) => void
  setImportDialogOpen: (open: boolean) => void
  setCreateEventDialogOpen: (open: boolean) => void
  setSettingsDialogOpen: (open: boolean) => void
  setShowingTrash: (open: boolean) => void
  getSettings: () => AppSettings
}

const defaultFilter: FilterOptions = {
  ratingMin: 0,
  ratingMax: 5,
  flag: null,
  colorLabel: null,
  dateFrom: null,
  dateTo: null,
  cameraModel: null,
  searchQuery: '',
  needsEdit: null,
  isEdited: null,
}

export const useUIStore = create<UIStore>()(
  persist(
    (set, get) => ({
      viewMode: 'grid',
      keyboardMode: 'vim',
      filterOptions: { ...defaultFilter },
      inspectorVisible: true,
      thumbnailSize: 200,
      importDialogOpen: false,
      createEventDialogOpen: false,
      settingsDialogOpen: false,
      showingTrash: false,

      setViewMode: (mode) => set({ viewMode: mode }),
      setKeyboardMode: (mode) => set({ keyboardMode: mode }),
      setFilterOptions: (options) =>
        set((s) => ({
          filterOptions: { ...s.filterOptions, ...options },
        })),
      resetFilter: () => set({ filterOptions: { ...defaultFilter } }),
      toggleInspector: () =>
        set((s) => ({ inspectorVisible: !s.inspectorVisible })),
      setThumbnailSize: (size) => set({ thumbnailSize: size }),
      setImportDialogOpen: (open) => set({ importDialogOpen: open }),
      setCreateEventDialogOpen: (open) =>
        set({ createEventDialogOpen: open }),
      setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
      setShowingTrash: (open) => set({ showingTrash: open }),
      getSettings: () => ({
        keyboardMode: get().keyboardMode,
        customShortcuts: {},
        thumbnailSize: get().thumbnailSize,
        sidebarWidth: 260,
        inspectorVisible: get().inspectorVisible,
        language: 'zh-CN',
      }),
    }),
    {
      name: 'photopeek-ui-store',
      partialize: (state) => ({
        keyboardMode: state.keyboardMode,
        thumbnailSize: state.thumbnailSize,
        inspectorVisible: state.inspectorVisible,
      }),
    }
  )
)

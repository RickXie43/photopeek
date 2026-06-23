import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ViewMode, FilterOptions, AppSettings, SortBy } from '../types/photo'

interface UIStore {
  viewMode: ViewMode
  filterOptions: FilterOptions
  inspectorVisible: boolean
  thumbnailSize: number
  importDialogOpen: boolean
  createEventDialogOpen: boolean
  settingsDialogOpen: boolean
  showingTrash: boolean
  sortBy: SortBy

  setViewMode: (mode: ViewMode) => void
  setFilterOptions: (options: Partial<FilterOptions>) => void
  resetFilter: () => void
  toggleInspector: () => void
  setThumbnailSize: (size: number) => void
  setImportDialogOpen: (open: boolean) => void
  setCreateEventDialogOpen: (open: boolean) => void
  setSettingsDialogOpen: (open: boolean) => void
  setShowingTrash: (open: boolean) => void
  setSortBy: (sortBy: SortBy) => void
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
      filterOptions: { ...defaultFilter },
      inspectorVisible: true,
      thumbnailSize: 200,
      importDialogOpen: false,
      createEventDialogOpen: false,
      settingsDialogOpen: false,
      showingTrash: false,
      sortBy: 'created_at',

      setViewMode: (mode) => set({ viewMode: mode }),
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
      setSortBy: (sortBy) => set({ sortBy }),
      getSettings: () => ({
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
        thumbnailSize: state.thumbnailSize,
        inspectorVisible: state.inspectorVisible,
      }),
    }
  )
)

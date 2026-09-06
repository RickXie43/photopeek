import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ViewMode, FilterOptions, AppSettings, SortBy, ExportPreset } from '../types/photo'

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
  exportDialogOpen: boolean
  exportPresets: ExportPreset[]

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
  setExportDialogOpen: (open: boolean) => void
  saveExportPreset: (name: string, options: ExportPreset['options']) => void
  deleteExportPreset: (id: string) => void
  renameExportPreset: (id: string, name: string) => void
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
      exportDialogOpen: false,
      exportPresets: [],

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
      setExportDialogOpen: (open) => set({ exportDialogOpen: open }),
      saveExportPreset: (name, options) =>
        set((s) => ({
          exportPresets: [
            ...s.exportPresets,
            { id: crypto.randomUUID(), name, options },
          ],
        })),
      deleteExportPreset: (id) =>
        set((s) => ({
          exportPresets: s.exportPresets.filter((p) => p.id !== id),
        })),
      renameExportPreset: (id, name) =>
        set((s) => ({
          exportPresets: s.exportPresets.map((p) =>
            p.id === id ? { ...p, name } : p
          ),
        })),
    }),
    {
      name: 'photopeek-ui-store',
      partialize: (state) => ({
        thumbnailSize: state.thumbnailSize,
        inspectorVisible: state.inspectorVisible,
        exportPresets: state.exportPresets,
      }),
    }
  )
)

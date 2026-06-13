import { create } from 'zustand'
import type { Photo } from '../types/photo'

interface PhotoStore {
  photos: Photo[]
  selectedPhotoIds: Set<string>
  loading: boolean
  trashPhotos: Photo[]
  trashLoading: boolean
  setPhotos: (photos: Photo[]) => void
  addPhotos: (photos: Photo[]) => void
  selectPhoto: (id: string) => void
  togglePhotoSelection: (id: string) => void
  clearSelection: () => void
  selectAll: () => void
  removePhotos: (ids: string[]) => void
  updatePhoto: (id: string, data: Partial<Photo>) => void
  setLoading: (loading: boolean) => void
  getSelectedPhoto: () => Photo | null
  setTrashPhotos: (photos: Photo[]) => void
  setTrashLoading: (loading: boolean) => void
}

export const usePhotoStore = create<PhotoStore>((set, get) => ({
  photos: [],
  selectedPhotoIds: new Set(),
  loading: false,
  trashPhotos: [],
  trashLoading: false,

  setPhotos: (photos) => set({ photos }),
  addPhotos: (photos) => set((s) => ({ photos: [...s.photos, ...photos] })),
  selectPhoto: (id) => set({ selectedPhotoIds: new Set([id]) }),
  togglePhotoSelection: (id) =>
    set((s) => {
      const next = new Set(s.selectedPhotoIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedPhotoIds: next }
    }),
  clearSelection: () => set({ selectedPhotoIds: new Set() }),
  selectAll: () =>
    set((s) => ({
      selectedPhotoIds: new Set([
        ...s.photos.map((p) => p.id),
        ...s.trashPhotos.map((p) => p.id),
      ]),
    })),
  removePhotos: (ids) =>
    set((s) => ({
      photos: s.photos.filter((p) => !ids.includes(p.id)),
      trashPhotos: s.trashPhotos.filter((p) => !ids.includes(p.id)),
      selectedPhotoIds: new Set(
        Array.from(s.selectedPhotoIds).filter((id) => !ids.includes(id))
      ),
    })),
  updatePhoto: (id, data) =>
    set((s) => ({
      photos: s.photos.map((p) => (p.id === id ? { ...p, ...data } : p)),
    })),
  setLoading: (loading) => set({ loading }),
  getSelectedPhoto: () => {
    const { photos, selectedPhotoIds } = get()
    const arr = Array.from(selectedPhotoIds)
    if (arr.length === 1) {
      return photos.find((p) => p.id === arr[0]) || null
    }
    return null
  },
  setTrashPhotos: (trashPhotos) => set({ trashPhotos }),
  setTrashLoading: (trashLoading) => set({ trashLoading }),
}))

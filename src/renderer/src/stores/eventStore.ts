import { create } from 'zustand'
import type { PhotoEvent } from '../types/photo'

interface EventStore {
  events: PhotoEvent[]
  selectedEventId: string | null
  loading: boolean
  setEvents: (events: PhotoEvent[]) => void
  setSelectedEvent: (id: string | null) => void
  addEvent: (event: PhotoEvent) => void
  removeEvent: (id: string) => void
  updateEvent: (id: string, data: Partial<PhotoEvent>) => void
  setLoading: (loading: boolean) => void
}

export const useEventStore = create<EventStore>((set) => ({
  events: [],
  selectedEventId: null,
  loading: false,
  setEvents: (events) => set({ events }),
  setSelectedEvent: (id) => set({ selectedEventId: id }),
  addEvent: (event) => set((s) => ({ events: [event, ...s.events] })),
  removeEvent: (id) =>
    set((s) => ({
      events: s.events.filter((e) => e.id !== id),
      selectedEventId: s.selectedEventId === id ? null : s.selectedEventId,
    })),
  updateEvent: (id, data) =>
    set((s) => ({
      events: s.events.map((e) => (e.id === id ? { ...e, ...data } : e)),
    })),
  setLoading: (loading) => set({ loading }),
}))

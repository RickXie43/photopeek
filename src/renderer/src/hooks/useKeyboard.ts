import { useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'
import { usePhotoStore } from '../stores/photoStore'
import { useEventStore } from '../stores/eventStore'

export function useKeyboard(): void {
  const { setViewMode, viewMode } =
    useUIStore()
  const {
    photos,
    selectedPhotoIds,
    selectPhoto,
    togglePhotoSelection,
    updatePhoto,
    clearSelection,
  } = usePhotoStore()
  const { selectedEventId } = useEventStore()

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      // Also check document.activeElement for extra safety
      const activeEl = document.activeElement as HTMLElement | null
      const isInput = (el: HTMLElement | null): boolean =>
        el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      if (isInput(target) || isInput(activeEl)) return

      // --- View mode shortcuts ---
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
        // 'g' as prefix key for Vim mode
        const onKeyUp = (up: KeyboardEvent): void => {
          if (up.key === 'v') setViewMode('grid')
          else if (up.key === 'l') setViewMode('loupe')
          else if (up.key === 'c') setViewMode('compare')
          else if (up.key === 's') setViewMode('survey')
          window.removeEventListener('keyup', onKeyUp)
        }
        window.addEventListener('keyup', onKeyUp)
        return
      }

      // --- Navigation ---
      const currentIndex = selectedPhotoIds.size === 1
        ? photos.findIndex((p) => selectedPhotoIds.has(p.id))
        : -1

      if (keyboardMode === 'vim') {
        // Skip j/k navigation when LoupeView is open (it handles j/k for version switching)
        const loupeActive = !!document.querySelector('[data-loupe="true"]')
        switch (e.key) {
          case 'j':
          case 'n':
            if (loupeActive) return
            e.preventDefault()
            if (currentIndex < photos.length - 1) {
              selectPhoto(photos[currentIndex + 1].id)
            }
            return
          case 'k':
          case 'p':
            if (loupeActive) return
            e.preventDefault()
            if (currentIndex > 0) {
              selectPhoto(photos[currentIndex - 1].id)
            }
            return
        }
      } else {
        // macOS style
        if (e.ctrlKey) {
          switch (e.key) {
            case 'n':
              e.preventDefault()
              if (currentIndex < photos.length - 1) {
                selectPhoto(photos[currentIndex + 1].id)
              }
              return
            case 'p':
              e.preventDefault()
              if (currentIndex > 0) {
                selectPhoto(photos[currentIndex - 1].id)
              }
              return
          }
        }
        // Arrow keys (common)
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          if (currentIndex < photos.length - 1) {
            selectPhoto(photos[currentIndex + 1].id)
          }
          return
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          if (currentIndex > 0) {
            selectPhoto(photos[currentIndex - 1].id)
          }
          return
        }
      }

      // --- Rating (common) ---
      if (['1', '2', '3', '4', '5'].includes(e.key) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const rating = parseInt(e.key)
        selectedPhotoIds.forEach((id) => {
          const photo = photos.find((p) => p.id === id)
          const newRating = photo?.rating === rating ? 0 : rating
          updatePhoto(id, { rating: newRating })
          window.electron.ipcRenderer.invoke('photos:updateRating', id, newRating)
        })
        return
      }

      // --- Flag (common) ---
      switch (e.key) {
        case 'p':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault()
            selectedPhotoIds.forEach((id) => {
              updatePhoto(id, { flag: 'pick' })
              window.electron.ipcRenderer.invoke('photos:updateFlag', id, 'pick')
            })
          }
          return
        case 'x':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault()
            selectedPhotoIds.forEach((id) => {
              updatePhoto(id, { flag: 'reject' })
              window.electron.ipcRenderer.invoke('photos:updateFlag', id, 'reject')
            })
          }
          return
        case 'u':
          e.preventDefault()
          selectedPhotoIds.forEach((id) => {
            updatePhoto(id, { flag: null })
            window.electron.ipcRenderer.invoke('photos:updateFlag', id, null)
          })
          return
        case 'e':
          // Toggle needs-edit
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault()
            selectedPhotoIds.forEach((id) => {
              const photo = photos.find((p) => p.id === id)
              const newVal = !photo?.needsEdit
              updatePhoto(id, { needsEdit: newVal })
              window.electron.ipcRenderer.invoke('photos:setNeedsEdit', id, newVal)
            })
          }
          return
      }

      // --- Selection ---
      if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        usePhotoStore.getState().selectAll()
        return
      }

      if (e.key === 'Escape') {
        clearSelection()
        return
      }

      // --- Search ---
      if (e.key === '/') {
        e.preventDefault()
        // Focus search would go here
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    viewMode,
    photos,
    selectedPhotoIds,
    selectPhoto,
    togglePhotoSelection,
    updatePhoto,
    clearSelection,
    setViewMode,
    selectedEventId,
  ])
}

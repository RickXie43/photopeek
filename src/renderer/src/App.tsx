import React, { useEffect } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { Toolbar } from './components/layout/Toolbar'
import { InspectorPanel } from './components/layout/InspectorPanel'
import { GridView } from './components/views/GridView'
import { CreateEventDialog } from './components/event/CreateEventDialog'
import { ImportDialog } from './components/event/ImportDialog'
import { SettingsDialog } from './components/ui/SettingsDialog'
import { useEventStore } from './stores/eventStore'
import { usePhotoStore } from './stores/photoStore'
import { useUIStore } from './stores/uiStore'
import { useKeyboard } from './hooks/useKeyboard'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-white dark:bg-gray-900">
          <div className="text-center p-8 max-w-md">
            <div className="text-4xl mb-4">⚠️</div>
            <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-2">应用出现错误</h1>
            <pre className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg mb-4 overflow-auto max-h-40">{this.state.error?.message || '未知错误'}</pre>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-[#007AFF] text-white rounded-lg text-sm"
            >
              重新加载
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function App(): React.JSX.Element {
  const { events, setEvents, selectedEventId, setSelectedEvent } = useEventStore()
  const { setPhotos, setTrashPhotos, setTrashLoading } = usePhotoStore()
  const {
    inspectorVisible,
    importDialogOpen,
    setImportDialogOpen,
    createEventDialogOpen,
    setCreateEventDialogOpen,
    settingsDialogOpen,
    setSettingsDialogOpen,
    showingTrash,
  } = useUIStore()

  // Enable keyboard shortcuts
  useKeyboard()

  // Load events on mount
  useEffect(() => {
    const loadEvents = async (): Promise<void> => {
      try {
        const result = await window.electron.ipcRenderer.invoke('events:list')
        setEvents(result as typeof events)
      } catch (err) {
        console.error('Failed to load events:', err)
      }
    }
    loadEvents()

    // Also reload events when refresh-events custom event is dispatched (e.g. after emptying trash)
    const handleRefresh = (): void => { loadEvents() }
    window.addEventListener('refresh-events', handleRefresh)
    return () => window.removeEventListener('refresh-events', handleRefresh)
  }, [setEvents])

  // Extract photo loading as reusable function
  const refreshData = React.useCallback(async (): Promise<void> => {
    // Reload events (covers photo count updates)
    try {
      const eventsResult = await window.electron.ipcRenderer.invoke('events:list')
      setEvents(eventsResult as typeof events)
    } catch (err) {
      console.error('Failed to reload events:', err)
    }

    // Reload photos for current event (skip if showing trash)
    if (showingTrash) return
    if (!selectedEventId) {
      setPhotos([])
      return
    }
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'photos:listByEvent',
        selectedEventId
      )
      setPhotos(result as any)
    } catch (err) {
      console.error('Failed to load photos:', err)
    }
  }, [selectedEventId, setPhotos, setEvents, showingTrash])

  // Load photos when event or trash state changes
  useEffect(() => {
    if (showingTrash) return
    refreshData()
  }, [refreshData, showingTrash])

  // Listen for real-time tag changes from shared web users → refresh photos
  useEffect(() => {
    if (!window.shareApi?.onTagAction) return
    const unsub = window.shareApi.onTagAction(() => {
      refreshData()
      window.dispatchEvent(new Event('refresh-tags'))
    })
    return unsub
  }, [refreshData])

  // Load trash photos when switching to trash view
  useEffect(() => {
    if (!showingTrash) return
    setTrashLoading(true)
    setPhotos([])
    setSelectedEvent(null)

    const loadTrash = async (): Promise<void> => {
      try {
        const result = await window.electron.ipcRenderer.invoke('photos:listTrash')
        setTrashPhotos(result as any)
      } catch (err) {
        console.error('Failed to load trash:', err)
      } finally {
        setTrashLoading(false)
      }
    }
    loadTrash()
  }, [showingTrash])

  return (
    <ErrorBoundary>
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--color-background)] text-[var(--color-text)]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Toolbar />
        <div className="flex-1 flex overflow-hidden">
          <GridView />
          {inspectorVisible && <InspectorPanel />}
        </div>
      </div>
      <CreateEventDialog
        open={createEventDialogOpen}
        onClose={() => setCreateEventDialogOpen(false)}
      />
      <ImportDialog
        open={importDialogOpen}
        onClose={() => setImportDialogOpen(false)}
        onImportComplete={refreshData}
      />
      <SettingsDialog
        open={settingsDialogOpen}
        onClose={() => setSettingsDialogOpen(false)}
      />
    </div>
    </ErrorBoundary>
  )
}

export default App

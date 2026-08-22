import * as React from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { KanbanColumnDef } from '@craft-agent/shared/projects/types'
import { SmartPointerSensor } from '@/components/ui/sortable-list'
import type { ProjectColorTreatment } from '@/utils/project-colors'
import type { SessionStatus } from '@/config/session-status-config'
import { useKanbanColumnColors, makeColumnColor } from '@/hooks/useKanbanColumnColors'
import { KanbanColumn } from './KanbanColumn'
import { TaskTile } from './TaskTile'
import {
  PORTRAIT_CAROUSEL_GAP,
  PORTRAIT_CAROUSEL_PADDING,
  getCarouselScrollSnapType,
  getCarouselSnapOffsets,
  getKanbanBoardLayout,
  getNearestCarouselIndex,
  isKanbanDragEnabled,
  type KanbanBoardLayout,
} from './kanban-carousel'
import type {
  KanbanColumnId,
  KanbanColumnMeta,
  KanbanModelProviderGroup,
  KanbanProject,
  KanbanTask,
} from './types'

interface KanbanBoardProps {
  /** Ordered columns to render. Built-ins carry `labelKey`; custom columns carry `name`. */
  columns: readonly KanbanColumnMeta[]
  tasks: KanbanTask[]
  projectsById: Map<string, KanbanProject>
  statusesById: Map<string, SessionStatus>
  /** Ordered workspace statuses for the per-tile status picker. */
  statuses?: SessionStatus[]
  /** Change a task's status from its tile. Enables the status-badge picker when set. */
  onChangeStatus?: (taskId: string, statusId: string) => void
  /** Project color treatment. Defaults to 'stripe-tint'. */
  treatment?: ProjectColorTreatment
  expandedTaskIds: Set<string>
  onTaskClick?: (taskId: string) => void
  /** Open the full-pane editor against a tile (edit mode). Enables the tile's "Edit task" action. */
  onEditTask?: (taskId: string) => void
  onToggleSubtasks?: (taskId: string) => void
  onSubtaskClick?: (taskId: string, subtaskId: string) => void
  onAddSubtask?: (taskId: string, title: string, model: string) => void
  /** Run all pending subtasks of a task. Shows each tile's Play button when set. */
  onRunSubtasks?: (taskId: string) => void
  /** Provider→model catalog for each tile's "Add subtask" composer. */
  subtaskModelGroups?: KanbanModelProviderGroup[]
  /** Model id pre-selected in the composer. */
  defaultSubtaskModel?: string
  /** Create a task tile from a typed title. Renders the inline composer in the first column. */
  onCreateTask?: (title: string) => void
  /** Move a tile to another column (drag-and-drop). Placement only — never touches status. */
  onMoveTask?: (taskId: string, toColumn: KanbanColumnId) => void
  /** Per-column status auto-applied on drop. Keyed by column id; empty = leave untouched. */
  columnDropStatus?: Partial<Record<KanbanColumnId, string>>
  /** Set a column's drop-status from its header. Enables the header picker when provided. */
  onSelectDropStatus?: (column: KanbanColumnId, statusId: string) => void
  /** Rename/recolor a custom column (single-project edit mode). Enables the column editor. */
  onUpdateColumn?: (columnId: string, patch: Partial<KanbanColumnDef>) => void
  /** Remove a custom column (single-project edit mode); its cards reassign to the first column. */
  onRemoveColumn?: (columnId: string) => void
  /** Append a new custom column (single-project edit mode). Renders the "add column" affordance. */
  onAddColumn?: () => void
  /** Scope for restoring the carousel column and per-column vertical scroll after navigation. */
  returnStateKey?: string
}

interface SavedBoardPosition {
  activeColumnId?: string
  columnScrollTop: Record<string, number>
}

const BOARD_POSITION_PREFIX = 'craft-kanban-position-v1:'

function readBoardPosition(key: string): SavedBoardPosition | null {
  try {
    const value = window.sessionStorage.getItem(`${BOARD_POSITION_PREFIX}${key}`)
    if (!value) return null
    const parsed = JSON.parse(value) as SavedBoardPosition
    return parsed && typeof parsed.columnScrollTop === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeBoardPosition(key: string, value: SavedBoardPosition): void {
  try {
    window.sessionStorage.setItem(`${BOARD_POSITION_PREFIX}${key}`, JSON.stringify(value))
  } catch {
    // Position memory is a progressive enhancement; a blocked storage backend
    // must never stop cards from opening or the board from scrolling.
  }
}

/**
 * The board. Renders the supplied `columns` and buckets tiles strictly by
 * `task.column` (placement is independent from the status badge); a tile whose
 * column id matches none of the active columns falls back to the first column.
 * The "New Task" composer lives at the top of the first column — creating a
 * parent session drops a named tile there.
 */
export function KanbanBoard({
  columns,
  tasks,
  projectsById,
  statusesById,
  statuses,
  onChangeStatus,
  treatment = 'stripe-tint',
  expandedTaskIds,
  onTaskClick,
  onEditTask,
  onToggleSubtasks,
  onSubtaskClick,
  onAddSubtask,
  onRunSubtasks,
  subtaskModelGroups,
  defaultSubtaskModel,
  onCreateTask,
  onMoveTask,
  columnDropStatus,
  onSelectDropStatus,
  onUpdateColumn,
  onRemoveColumn,
  onAddColumn,
  returnStateKey = 'all-tasks',
}: KanbanBoardProps) {
  const { t } = useTranslation()
  const firstColumnId = columns[0]?.id

  const tasksByColumn = React.useMemo(() => {
    const known = new Set(columns.map(c => c.id))
    const buckets = new Map<KanbanColumnId, KanbanTask[]>()
    for (const c of columns) buckets.set(c.id, [])
    for (const task of tasks) {
      // A tile whose persisted column no longer exists falls back to the first column.
      const target = known.has(task.column) ? task.column : firstColumnId
      if (target === undefined) continue
      buckets.get(target)!.push(task)
    }
    // Newest tiles first within each column (a freshly created task lands on top).
    const recency = (t: KanbanTask) => t.createdAt ?? t.lastMessageAt ?? 0
    for (const list of buckets.values()) list.sort((a, b) => recency(b) - recency(a))
    return buckets
  }, [tasks, columns, firstColumnId])

  const columnColors = useKanbanColumnColors()

  const [activeId, setActiveId] = React.useState<string | null>(null)
  // 5px threshold so a click-to-open isn't read as a drag; the sensor also skips
  // elements marked data-no-dnd (chevron toggle, "Add subtask" composer).
  const sensors = useSensors(useSensor(SmartPointerSensor, { activationConstraint: { distance: 5 } }))

  const scrollViewportRef = React.useRef<HTMLDivElement>(null)
  const scrollFrameRef = React.useRef<number | null>(null)
  const columnIdsKey = React.useMemo(() => columns.map(column => column.id).join('\u001f'), [columns])
  const [layout, setLayout] = React.useState<KanbanBoardLayout>(() =>
    typeof window === 'undefined' ? 'row' : getKanbanBoardLayout(window.innerWidth, window.innerHeight)
  )
  const [activeColumnIndex, setActiveColumnIndex] = React.useState(0)
  const activeColumnIndexRef = React.useRef(0)
  activeColumnIndexRef.current = activeColumnIndex

  const getSnapOffsets = React.useCallback(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return []
    const columnOffsets = Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-kanban-column-id]'),
      column => column.offsetLeft
    )
    const scrollPaddingStart = Number.parseFloat(window.getComputedStyle(viewport).scrollPaddingLeft) || 0
    return getCarouselSnapOffsets(columnOffsets, scrollPaddingStart)
  }, [])

  const saveBoardPosition = React.useCallback(
    (forcedIndex?: number) => {
      const viewport = scrollViewportRef.current
      if (!viewport) return
      const snapOffsets = getSnapOffsets()
      const measuredIndex = getNearestCarouselIndex(viewport.scrollLeft, snapOffsets)
      const index = forcedIndex ?? measuredIndex
      const columnScrollTop: Record<string, number> = {}
      viewport.querySelectorAll<HTMLElement>('[data-kanban-column-scroll]').forEach(column => {
        const id = column.dataset.kanbanColumnScroll
        if (id) columnScrollTop[id] = column.scrollTop
      })
      writeBoardPosition(returnStateKey, {
        activeColumnId: columns[index]?.id,
        columnScrollTop,
      })
    },
    [columns, getSnapOffsets, returnStateKey]
  )

  const alignColumn = React.useCallback(
    (index: number, behavior: ScrollBehavior = 'auto', persist = true) => {
      const viewport = scrollViewportRef.current
      const offsets = getSnapOffsets()
      if (!viewport || offsets.length === 0) return
      const boundedIndex = Math.max(0, Math.min(index, offsets.length - 1))
      viewport.scrollTo({ left: offsets[boundedIndex], behavior })
      activeColumnIndexRef.current = boundedIndex
      setActiveColumnIndex(boundedIndex)
      if (persist) saveBoardPosition(boundedIndex)
    },
    [getSnapOffsets, saveBoardPosition]
  )

  const schedulePositionUpdate = React.useCallback(() => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const viewport = scrollViewportRef.current
      if (!viewport) return
      const index = getNearestCarouselIndex(viewport.scrollLeft, getSnapOffsets())
      if (index !== activeColumnIndexRef.current) {
        activeColumnIndexRef.current = index
        setActiveColumnIndex(index)
      }
      saveBoardPosition(index)
    })
  }, [getSnapOffsets, saveBoardPosition])

  // Restore both axes after returning from a card. The column id, rather than a
  // stale pixel offset, survives width/orientation changes and custom columns.
  React.useLayoutEffect(() => {
    const saved = readBoardPosition(returnStateKey)
    const restoredIndex = saved?.activeColumnId
      ? Math.max(0, columns.findIndex(column => column.id === saved.activeColumnId))
      : 0
    activeColumnIndexRef.current = restoredIndex
    setActiveColumnIndex(restoredIndex)
    const frame = requestAnimationFrame(() => {
      alignColumn(restoredIndex, 'auto', false)
      const viewport = scrollViewportRef.current
      if (!viewport) return
      if (saved) {
        viewport.querySelectorAll<HTMLElement>('[data-kanban-column-scroll]').forEach(column => {
          const id = column.dataset.kanbanColumnScroll
          if (id) column.scrollTop = saved.columnScrollTop[id] ?? 0
        })
      }
      saveBoardPosition(restoredIndex)
    })
    return () => cancelAnimationFrame(frame)
  }, [returnStateKey, columnIdsKey, columns, alignColumn, saveBoardPosition])

  // Re-evaluate only on viewport changes. On both orientation transitions, align
  // the remembered column to its new real DOM snap point so no partial column is
  // left onscreen; row mode itself remains the existing flex layout.
  React.useEffect(() => {
    const handleViewportChange = () => {
      setLayout(getKanbanBoardLayout(window.innerWidth, window.innerHeight))
      requestAnimationFrame(() => alignColumn(activeColumnIndexRef.current))
    }
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('orientationchange', handleViewportChange)
    return () => {
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('orientationchange', handleViewportChange)
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [alignColumn])

  const handleTaskClick = React.useCallback(
    (taskId: string) => {
      saveBoardPosition()
      onTaskClick?.(taskId)
    },
    [onTaskClick, saveBoardPosition]
  )
  const handleEditTaskClick = React.useCallback(
    (taskId: string) => {
      saveBoardPosition()
      onEditTask?.(taskId)
    },
    [onEditTask, saveBoardPosition]
  )
  const handleSubtaskClick = React.useCallback(
    (taskId: string, subtaskId: string) => {
      saveBoardPosition()
      onSubtaskClick?.(taskId, subtaskId)
    },
    [onSubtaskClick, saveBoardPosition]
  )

  const activeTask = activeId ? tasks.find(t => t.id === activeId) ?? null : null

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }, [])

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      if (!over) return
      const toColumn = over.id as KanbanColumnId
      const task = tasks.find(t => t.id === String(active.id))
      if (!task || task.column === toColumn) return
      onMoveTask?.(String(active.id), toColumn)
    },
    [tasks, onMoveTask]
  )

  const boundedActiveIndex = Math.max(0, Math.min(activeColumnIndex, Math.max(0, columns.length - 1)))
  const activeColumn = columns[boundedActiveIndex]
  const activeColumnLabel = activeColumn?.labelKey ? t(activeColumn.labelKey) : (activeColumn?.name ?? '')

  return (
    <DndContext
      // A card must not steal a horizontal phone swipe as a drag. Touch DnD is
      // outside this contract; desktop/landscape keep the existing sensor set.
      sensors={isKanbanDragEnabled(layout) ? sensors : []}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        data-kanban-layout={layout}
        style={
          {
            '--kanban-carousel-padding': `${PORTRAIT_CAROUSEL_PADDING}px`,
            '--kanban-carousel-gap': `${PORTRAIT_CAROUSEL_GAP}px`,
            '--kanban-carousel-gutter-total': `${PORTRAIT_CAROUSEL_PADDING * 2}px`,
          } as React.CSSProperties
        }
      >
        <div
          ref={scrollViewportRef}
          data-kanban-scroll
          className="min-h-0 flex-1 overflow-x-auto"
          style={{ scrollSnapType: getCarouselScrollSnapType(layout) }}
          onScrollCapture={schedulePositionUpdate}
        >
          <div data-kanban-track className="flex h-full min-w-max gap-3 p-3">
        {columns.map((column, index) => (
          <KanbanColumn
            key={column.id}
            column={column}
            // Custom columns carry their own accent; built-ins resolve from the global color hook.
            color={column.color ? makeColumnColor(column.color) : columnColors.get(column.id)}
            tasks={tasksByColumn.get(column.id) ?? []}
            projectsById={projectsById}
            statusesById={statusesById}
            statuses={statuses}
            onChangeStatus={onChangeStatus}
            treatment={treatment}
            expandedTaskIds={expandedTaskIds}
            onTaskClick={onTaskClick ? handleTaskClick : undefined}
            onEditTask={onEditTask ? handleEditTaskClick : undefined}
            onToggleSubtasks={onToggleSubtasks}
            onSubtaskClick={onSubtaskClick ? handleSubtaskClick : undefined}
            onAddSubtask={onAddSubtask}
            onRunSubtasks={onRunSubtasks}
            subtaskModelGroups={subtaskModelGroups}
            defaultSubtaskModel={defaultSubtaskModel}
            onCreateTask={index === 0 ? onCreateTask : undefined}
            dropStatusId={column.dropStatusId ?? columnDropStatus?.[column.id]}
            onSelectDropStatus={
              onSelectDropStatus ? statusId => onSelectDropStatus(column.id, statusId) : undefined
            }
            onRename={onUpdateColumn ? name => onUpdateColumn(column.id, { name }) : undefined}
            onSetColor={onUpdateColumn ? color => onUpdateColumn(column.id, { color }) : undefined}
            // Guard against removing the last column — the board must always keep one.
            onRemove={onRemoveColumn && columns.length > 1 ? () => onRemoveColumn(column.id) : undefined}
          />
        ))}
        {onAddColumn && (
          <button
            type="button"
            onClick={onAddColumn}
            title={t('kanban.column.add')}
            className="flex h-9 w-9 shrink-0 items-center justify-center self-start rounded-lg border border-dashed border-border text-foreground/50 transition-colors hover:border-border/80 hover:bg-foreground/[0.03] hover:text-foreground/80"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
          </button>
        )}
          </div>
        </div>

        <div
          className="kanban-carousel-indicator"
          aria-live="polite"
          aria-label={`${activeColumnLabel} — ${boundedActiveIndex + 1} / ${columns.length}`}
        >
          <span className="max-w-[60%] truncate text-[11px] font-semibold text-foreground/70">
            {activeColumnLabel}
          </span>
          <span className="text-[11px] tabular-nums text-foreground/50">
            {boundedActiveIndex + 1} / {columns.length}
          </span>
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {columns.map((column, index) => (
              <span
                key={column.id}
                className={`h-1.5 rounded-full transition-[width,background-color] ${
                  index === boundedActiveIndex ? 'w-4 bg-foreground/65' : 'w-1.5 bg-foreground/20'
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* position:fixed overlay clone — escapes the column's overflow clipping.
          dropAnimation is disabled: on a cross-column drop the source tile is
          gone (it re-renders into the target), so a "fly back" would be wrong. */}
      <DragOverlay dropAnimation={null} style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
        {activeTask ? (
          <div className="cursor-grabbing rounded-lg shadow-dragging" style={{ transform: 'scale(1.025)' }}>
            <TaskTile
              task={activeTask}
              project={activeTask.projectId ? projectsById.get(activeTask.projectId) : undefined}
              status={statusesById.get(activeTask.statusId)}
              treatment={treatment}
              expanded={expandedTaskIds.has(activeTask.id)}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

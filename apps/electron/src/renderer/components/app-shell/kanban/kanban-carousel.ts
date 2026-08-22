export const PORTRAIT_CAROUSEL_MAX_WIDTH = 767
export const PORTRAIT_CAROUSEL_PADDING = 12
export const PORTRAIT_CAROUSEL_GAP = 12

export type KanbanBoardLayout = 'portrait-carousel' | 'row'

export interface PortraitCarouselGeometry {
  columnWidth: number
  snapStride: number
}

/**
 * The phone carousel is deliberately portrait-only. Narrow landscape windows
 * keep the existing multi-column row instead of silently becoming a carousel.
 */
export function getKanbanBoardLayout(viewportWidth: number, viewportHeight: number): KanbanBoardLayout {
  return viewportWidth <= PORTRAIT_CAROUSEL_MAX_WIDTH && viewportHeight > viewportWidth
    ? 'portrait-carousel'
    : 'row'
}

/**
 * Geometry shared by the responsive contract tests and the runtime snap model.
 * A column fills the usable viewport after safe areas and the track's two 12px
 * gutters; the next snap point is exactly one column plus the existing 12px gap.
 */
export function getPortraitCarouselGeometry(
  viewportWidth: number,
  safeAreaStart = 0,
  safeAreaEnd = 0,
  padding = PORTRAIT_CAROUSEL_PADDING,
  gap = PORTRAIT_CAROUSEL_GAP
): PortraitCarouselGeometry {
  const columnWidth = Math.max(0, viewportWidth - safeAreaStart - safeAreaEnd - padding * 2)
  return { columnWidth, snapStride: columnWidth + gap }
}

export function getCarouselSnapOffsets(columnOffsets: readonly number[], scrollPaddingStart: number): number[] {
  return columnOffsets.map(offset => Math.max(0, offset - scrollPaddingStart))
}

export function getNearestCarouselIndex(scrollLeft: number, snapOffsets: readonly number[]): number {
  if (snapOffsets.length === 0) return 0
  let nearest = 0
  let nearestDistance = Math.abs(scrollLeft - snapOffsets[0]!)
  for (let index = 1; index < snapOffsets.length; index += 1) {
    const distance = Math.abs(scrollLeft - snapOffsets[index]!)
    if (distance < nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  }
  return nearest
}

export function getCarouselScrollSnapType(layout: KanbanBoardLayout): 'x mandatory' | 'none' {
  return layout === 'portrait-carousel' ? 'x mandatory' : 'none'
}

export function isKanbanDragEnabled(layout: KanbanBoardLayout): boolean {
  return layout === 'row'
}

/** Applied to every column; it is inert while the row viewport has snap disabled. */
export const KANBAN_COLUMN_SNAP_STYLE = {
  scrollSnapAlign: 'start',
  scrollSnapStop: 'always',
} as const

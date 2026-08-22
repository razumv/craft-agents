import { describe, expect, it } from 'bun:test'
import {
  KANBAN_COLUMN_SNAP_STYLE,
  getCarouselScrollSnapType,
  getCarouselSnapOffsets,
  getKanbanBoardLayout,
  getNearestCarouselIndex,
  getPortraitCarouselGeometry,
  isKanbanDragEnabled,
} from '../kanban-carousel'

describe('Kanban portrait carousel contract', () => {
  it('gives one column the full usable width at 375px and one exact snap stride', () => {
    const geometry = getPortraitCarouselGeometry(375)

    // 375px viewport - the existing 12px track gutter on each edge.
    expect(geometry.columnWidth).toBe(351)
    // A snap advances by exactly one full column plus the existing 12px gap.
    expect(geometry.snapStride).toBe(363)

    const offsets = getCarouselSnapOffsets([12, 375, 738], 12)
    expect(offsets).toEqual([0, 363, 726])
    expect(getNearestCarouselIndex(363, offsets)).toBe(1)
    expect(KANBAN_COLUMN_SNAP_STYLE).toEqual({
      scrollSnapAlign: 'start',
      scrollSnapStop: 'always',
    })
  })

  it('subtracts both safe-area edges from the usable portrait column', () => {
    expect(getPortraitCarouselGeometry(375, 8, 8)).toEqual({
      columnWidth: 335,
      snapStride: 347,
    })
  })

  it('keeps desktop and phone landscape as the unsnapped multi-column row', () => {
    expect(getKanbanBoardLayout(375, 812)).toBe('portrait-carousel')
    expect(getCarouselScrollSnapType('portrait-carousel')).toBe('x mandatory')
    expect(isKanbanDragEnabled('portrait-carousel')).toBe(false)

    expect(getKanbanBoardLayout(1024, 768)).toBe('row')
    expect(getKanbanBoardLayout(844, 390)).toBe('row')
    expect(getCarouselScrollSnapType('row')).toBe('none')
    expect(isKanbanDragEnabled('row')).toBe(true)
  })
})

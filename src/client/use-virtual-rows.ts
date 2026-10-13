import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** Keep DOM size independent of the PDF page count or outline length. */
export function useVirtualRows(count: number, rowHeight: number, active: boolean) {
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const [position, setPosition] = useState({ top: 0, height: 480 })

  useLayoutEffect(() => {
    const element = root.current
    if (!element || !active) return
    const update = () => {
      frame.current = 0
      setPosition({ top: element.scrollTop, height: element.clientHeight })
    }
    const schedule = () => { if (!frame.current) frame.current = requestAnimationFrame(update) }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    element.addEventListener('scroll', schedule, { passive: true })
    update()
    return () => {
      element.removeEventListener('scroll', schedule)
      observer.disconnect()
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [active, count])

  const scrollToRow = useCallback((index: number, onlyIfOutside = false) => {
    const element = root.current
    if (!element || index < 0 || index >= count) return
    const top = index * rowHeight
    if (!onlyIfOutside || top < element.scrollTop || top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - Math.max(0, (element.clientHeight - rowHeight) / 2))
    }
  }, [count, rowHeight])

  const start = Math.max(0, Math.floor(position.top / rowHeight) - 3)
  const end = Math.min(count, Math.ceil((position.top + position.height) / rowHeight) + 3)
  return { root, start, end, scrollToRow, totalHeight: count * rowHeight }
}

/** Space available for sidebar sizing and auto-collapse beside the floating tool rail. */
export function readerPaneWidth(body: HTMLElement): number {
  const toolRail = body.querySelector<HTMLElement>(':scope > [data-pdf-tool-rail]')
  const railWidth = toolRail?.getBoundingClientRect().width ?? 0
  return Math.max(0, body.clientWidth - railWidth)
}

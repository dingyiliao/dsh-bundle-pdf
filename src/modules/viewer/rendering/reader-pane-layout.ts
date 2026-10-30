/** Width shared by the PDF and reading sidebar after the docked tool rail. */
export function readerPaneWidth(body: HTMLElement): number {
  const toolRail = body.querySelector<HTMLElement>(':scope > [data-pdf-tool-rail]')
  const railWidth = toolRail?.getBoundingClientRect().width ?? 0
  return Math.max(0, body.clientWidth - railWidth)
}

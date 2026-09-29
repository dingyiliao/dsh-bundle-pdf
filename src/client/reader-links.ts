import type { PageViewport } from './reader-selection.js'

export interface PdfLink {
  id: string
  rect: number[]
  quadPoints?: number[]
  dest?: unknown
  url?: string
  action?: string
}

const namedActions = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage'])

export function namedLinkAction(action: string | undefined): action is string {
  return !!action && namedActions.has(action)
}

export function safeLinkUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

export function actionableLink(link: PdfLink): boolean {
  return !!link.dest || namedLinkAction(link.action) || !!safeLinkUrl(link.url)
}

function pointInQuad(x: number, y: number, quad: number[]): boolean {
  const corners = [0, 2, 6, 4]
  let sign = 0
  for (let index = 0; index < corners.length; index++) {
    const first = corners[index], second = corners[(index + 1) % corners.length]
    const cross = (quad[second] - quad[first]) * (y - quad[first + 1]) - (quad[second + 1] - quad[first + 1]) * (x - quad[first])
    if (Math.abs(cross) < 0.00001) continue
    const next = Math.sign(cross)
    if (sign && sign !== next) return false
    sign = next
  }
  return sign !== 0
}

/** Hit native geometry without putting an interactive element above selectable text. */
export function linkAtPoint(links: readonly PdfLink[], viewport: PageViewport, point: [number, number]): PdfLink | undefined {
  const [x, y] = viewport.convertToPdfPoint(point[0], point[1])
  for (let index = links.length - 1; index >= 0; index--) {
    const link = links[index]
    if (!actionableLink(link) || link.rect.length !== 4 || !link.rect.every(Number.isFinite)) continue
    const [left, bottom, right, top] = link.rect
    if (x < Math.min(left, right) || x > Math.max(left, right) || y < Math.min(bottom, top) || y > Math.max(bottom, top)) continue
    if (link.quadPoints?.length && link.quadPoints.length % 8 === 0 && link.quadPoints.every(Number.isFinite)) {
      let inside = false
      for (let offset = 0; offset < link.quadPoints.length; offset += 8) {
        if (pointInQuad(x, y, link.quadPoints.slice(offset, offset + 8))) { inside = true; break }
      }
      if (!inside) continue
    }
    return link
  }
  return undefined
}

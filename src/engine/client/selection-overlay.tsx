import type { ReaderSelection, PageViewport } from '../../client/viewer/index.js'

export function NativeSelectionOverlay({ fragment, viewport }: {
  fragment: ReaderSelection['fragments'][number]
  viewport: PageViewport
}) {
  const { quadPoints } = fragment
  const paths: string[] = []
  for (let i = 0; i + 7 < quadPoints.length; i += 8) {
    const points = [0, 2, 6, 4].map(offset =>
      viewport.convertToViewportPoint(quadPoints[i + offset], quadPoints[i + offset + 1]))
    paths.push(`M${points.map(point => point.join(' ')).join('L')}Z`)
  }
  return <svg className="dsh-pdf-selection-overlay" width={viewport.width} height={viewport.height} aria-hidden="true">
    <path fill="var(--dsw-alias-bg-document-selection, rgba(65, 120, 250, 0.3))" d={paths.join(' ')} />
  </svg>
}

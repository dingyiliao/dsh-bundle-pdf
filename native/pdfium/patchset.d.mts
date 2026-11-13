export interface PdfiumPatchStep {
  id: string
  apply: string
  sources: string[]
}

export interface PdfiumPatchset {
  format: 1
  sourceRevision: string
  steps: PdfiumPatchStep[]
}

export function readPatchset(): Promise<PdfiumPatchset>
export function patchsetDigest(): Promise<string>

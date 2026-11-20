export interface PdfiumPatchStep {
  id: string
  patch: string
}

export interface PdfiumPatchset {
  format: 2
  sourceRevision: string
  steps: PdfiumPatchStep[]
}

export function readPatchset(): Promise<PdfiumPatchset>
export function patchsetDigest(): Promise<string>

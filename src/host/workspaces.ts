/** Compatibility entrypoint: the working-copy module owns all mutations and drafts. */
import { pdfLibDocumentAdapter } from '../adapters/host/pdf-lib/document-adapter.ts'
import { createV1DraftRepository } from '../adapters/host/storage/v1-drafts.ts'
import { createWorkingCopyService, type V1DraftPort, type WorkingCopyFilePort } from '../modules/working-copy/index.ts'

export function createWorkspaces(files: WorkingCopyFilePort, drafts: V1DraftPort) {
  return createWorkingCopyService(files, createV1DraftRepository(drafts), pdfLibDocumentAdapter)
}
export type { HostWorkspaceSnapshot } from '../modules/working-copy/index.ts'

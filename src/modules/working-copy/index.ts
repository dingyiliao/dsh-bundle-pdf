export type { HostWorkspaceSnapshot, WorkingCopyReadPort, DocumentResidency, DocumentReleaseStatus, OpenWorkingCopyDocument } from './ports.js'
export { createWorkingCopyService } from './service.js'
export type {
  PdfDocumentPort, V1DraftPort, WorkingCopyDraftPort, WorkingCopyAgent, WorkingCopyFilePort, WorkingCopyFileRead,
} from './ports.js'
export type { DraftRecord, WorkspaceRecord } from './schema.js'
export { operationSchema, requestSchema } from '../../contracts/rpc/index.js'
export { draftSchema } from './schema.js'
export { operationsThrough, projectedDocument, appendGroup, moveCursor } from './history.js'
export { projectFormOperations } from './form-projection.js'
export { expectedSaveVersion } from './save-plan.js'
export type { SaveOptions } from './save-plan.js'
export { createBackgroundDocuments } from './background-documents.js'
export type { BackgroundWorkspacePort, BackgroundReaderPort } from './background-documents.js'

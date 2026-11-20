export type { HostWorkspaceSnapshot, WorkingCopyReadPort, DocumentResidency, DocumentReleaseStatus, OpenWorkingCopyDocument } from './ports.js'
export { createWorkingCopyService } from './service.js'
export type {
  PdfDocumentPort, ProtectedDocumentPort, V1DraftPort, WorkingCopyDraftPort, WorkingCopyAgent, WorkingCopyFilePort, WorkingCopyFileRead,
} from './ports.js'
export type { DraftRecord, WorkspaceRecord } from './schema.js'
export type {
  BaselineAcquireFailure, BaselineAcquireResult, BaselineId, BaselineProvider, BaselineResource,
  ContentContext, ContentSnapshot, OperationGroup, OperationSet, SourceVersion, WorkingCopyRecord,
} from './model.js'
export { asBaselineId, contentSnapshotOf, operationSetOf, sourceVersionOf } from './model.js'
export { operationSchema, requestSchema } from '../../../contracts/rpc/index.js'
export { draftSchema } from './schema.js'
export { operationsThrough, projectedDocument, projectWorkingCopyOperations, appendGroup, moveCursor } from './history.js'
export { projectFormOperations } from './form-projection.js'
export { expectedSaveVersion } from './save-plan.js'
export type { SaveOptions } from './save-plan.js'
export { createBaselineGateway, classifyBaselineFailure } from './baseline-gateway.js'
export type { BaselineAccess } from './baseline-gateway.js'
export { createWorkingCopyRegistry } from './registry.js'
export type { WorkingCopyRegistry, DocumentReferences, SuspendedCopy } from './registry.js'
export { createWorkingCopyTransitions } from './transitions.js'
export { createBackgroundDocuments } from './background-documents.js'
export type { BackgroundWorkspacePort, BackgroundReaderPort } from './background-documents.js'

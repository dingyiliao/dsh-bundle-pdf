import type { HostWorkspaceSnapshot } from '../../../modules/working-copy/index.js'
import type { AgentImageUnderstandingPort, AgentOcrPort } from '../../../modules/evidence/index.js'

type Capability = { supported: boolean; available: boolean; reason?: string }

async function probe(service: Pick<AgentOcrPort, 'availability'> | Pick<AgentImageUnderstandingPort, 'availability'> | undefined, label: string,
  sessionId: string, signal: AbortSignal): Promise<Capability> {
  if (!service) return { supported: false, available: false, reason: `${label} plugin is not installed` }
  try {
    const result = await service.availability(sessionId, signal)
    signal.throwIfAborted()
    return { supported: true, available: result.status === 'available',
      ...(result.status === 'available' ? {} : { reason: ('reason' in result ? result.reason : undefined) ?? `${label} backend is ${result.status}` }) }
  } catch {
    signal.throwIfAborted()
    return { supported: true, available: false, reason: `${label} backend availability could not be verified` }
  }
}

/** Report this document and selected backends, not just registered service names. */
export async function documentCapabilities(snapshot: HostWorkspaceSnapshot, sessionId: string,
  services: { ocr?: Pick<AgentOcrPort, 'availability'>; image?: Pick<AgentImageUnderstandingPort, 'availability'>;
    retrieval?: Pick<AgentOcrPort, 'availability'>;
    navigation: boolean; visible: boolean },
  signal: AbortSignal) {
  signal.throwIfAborted()
  const document = snapshot.document
  const readOnly = document.readOnly || document.signed || document.encrypted
  const writeReason = readOnly ? document.readOnlyReason ?? 'This PDF is read-only'
    : snapshot.conflict ? 'The PDF source conflicts with this draft; resolve the conflict before writing' : undefined
  const [ocr, imageUnderstanding, semanticSearch] = await Promise.all([
    probe(services.ocr, 'OCR', sessionId, signal), probe(services.image, 'Image understanding', sessionId, signal),
    probe(services.retrieval, 'Semantic retrieval', sessionId, signal),
  ])
  signal.throwIfAborted()
  const annotation = { supported: true, available: writeReason === undefined,
    ...(writeReason ? { reason: writeReason } : {}) }
  const forms = { supported: document.formKind === 'acroform',
    available: writeReason === undefined && document.formKind === 'acroform'
      && Boolean(document.formFields?.some(field => !field.readOnly && field.type !== 'unsupported' && field.widgets.length)),
    ...(writeReason ? { reason: writeReason } : document.formKind !== 'acroform'
      ? { reason: 'This PDF has no supported AcroForm' }
      : !document.formFields?.some(field => !field.readOnly && field.type !== 'unsupported' && field.widgets.length)
        ? { reason: 'This PDF has no writable form fields' } : {}) }
  const outlineReason = document.outlineReadOnlyReason
    ?? (document.outline === undefined ? 'This PDF outline could not be inspected' : undefined)
  const bookmarks = { supported: outlineReason === undefined,
    available: writeReason === undefined && outlineReason === undefined,
    ...(writeReason || outlineReason ? { reason: writeReason ?? outlineReason } : {}) }
  const navigation = { supported: services.navigation, available: services.navigation && services.visible,
    ...(!services.navigation ? { reason: 'Reader navigation is not installed' }
      : !services.visible ? { reason: 'No matching PDF Reader is visible' } : {}) }
  return { readOnly, ...(document.readOnlyReason ? { readOnlyReason: document.readOnlyReason } : {}),
    capabilities: { readText: true, searchText: true, findRelatedText: true, semanticSearch: semanticSearch.available,
      writeAnnotations: annotation.available, fillForms: forms.available, editBookmarks: bookmarks.available,
      navigateVisibleReader: navigation.available, ocr: ocr.available, imageUnderstanding: imageUnderstanding.available },
    capabilityDetails: { writeAnnotations: annotation, fillForms: forms, editBookmarks: bookmarks,
      navigateVisibleReader: navigation, ocr, imageUnderstanding, semanticSearch } }
}

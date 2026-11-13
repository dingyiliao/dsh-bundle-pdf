export type ImageUnderstandingAvailability =
  | { status: 'available'; kind: 'direct-image' | 'derived-text'; backendId: string; limitation?: string }
  | { status: 'unavailable'; reason: string }

export interface ImageEvidenceIdentity {
  refId: string
  documentId: string
  page: number
  locator: { kind: 'page-only' } | { kind: 'pdf-region'; rectPdf: [number, number, number, number] }
  sourceDigest: string
  sourceVersion: string
  contentVersion: string
  revision: number
  renderedImageSha256: string
}

/**
 * A Host-verified image reference. Direct-image bytes are the exact validated
 * attachment bytes returned by Host; callers must not substitute a Client Blob.
 */
export type PreparedImageReference =
  | { kind: 'direct-image'; backendId: string; requestedRefId: string;
    provenance: { backendId: string; mode: 'session-vision' };
    evidence: ImageEvidenceIdentity;
    image: { mediaType: 'image/png'; data: Uint8Array; width: number; height: number } }
  | { kind: 'derived-text'; backendId: string; requestedRefId: string; text: string;
    provenance: { backendId: string; mode: 'image-description'; backendVersion?: string; model?: string };
    limitations?: string; evidence: ImageEvidenceIdentity }

/** Viewer-facing image port, independent of the DSH RPC carrier. */
export interface ImageUnderstandingApi {
  availability(sessionId: string, signal?: AbortSignal): Promise<ImageUnderstandingAvailability>
  /** Resolve a Host evidence ref; the image bytes never come from Client state. */
  prepareReference(request: { sessionId: string; documentId: string; refId: string; question: string },
    signal?: AbortSignal): Promise<PreparedImageReference>
}

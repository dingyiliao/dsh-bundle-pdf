# Working-copy abstraction model

This document is the compact contract behind Reader and model PDF entry points.

## Four layers

```text
source file
  -> BaselineResource { baselineId, source, bytes, document }
  + OperationSet { baselineId, groups, cursor, revision }
  -> ContentContext / renderer-specific ContentSnapshot
```

- `WorkingCopyRecord` is the logical durable identity: canonical path, source version, and operations. It remains valid when native memory is evicted.
- `BaselineResource` is one fixed source-byte version and its parsed document metadata. `baselineId` is the SHA-256 identity of those bytes. It is not the filesystem version.
- `OperationSet` is the editable state. Every operation set is bound to the baseline it projects from; a baseline mismatch never silently clears it.
- `ContentContext` is the shared stale fence for Reader and model renderers. It carries `baselineId`, working-copy `revision`, `contentVersion`, and optional page-content/index digests. It never carries a password or native handle.
- `ContentSnapshot` adds a renderer (`reader` or `agent`) and renderer output to the shared context. Reader rendering is continuous; model rendering is bounded and one-shot.

## Baseline acquisition

`BaselineProvider` owns file bytes, encryption, password retry, parser/native acquisition, and failure classification. A model-only open uses the same provider as Reader. If Reader already owns the active working copy, model tools reuse that baseline; otherwise they acquire it for the scoped operation. Passwords stay in Host memory and are never persisted or sent through Client RPC.

An acquisition failure is an open failure only. The existing operation set remains intact. Releasing native memory does not release the logical working copy; a later operation reacquires the same baseline identity or reports a mismatch.

## Native boundary

`NativeBaselineRef` is Host-only:

```ts
{ baselineId: string; documentId: string; generation: number }
```

`documentId` is a random identifier in one worker process. `generation` prevents a stale close from starting a replacement worker or sending an old identifier to a new process. The ref is scoped to the PDFium adapter and is never placed in a snapshot, draft, or wire response.

## Mismatch and atomicity

When the source digest changes while operations are dirty, the snapshot reports `conflict` and `baselineMismatch` with `adopt-current` and `retain-operations` choices. Model `pdf_open` may pass `baselineChoice: "adopt-current"` (and a password when needed) to replace the baseline after the choice is explicit; `"retain-operations"` keeps the old baseline and draft. Applying operations is atomic: parse/projection/materialization failures preserve every operation and publish no partial snapshot.

## Signatures

A signature is not a write gate. `PdfDocumentInfo.signed` reports confirmed signature data; `signatureUncertain` reports that native inspection could not prove signatures absent and is carried as a save-time risk rather than read-only state. For a certification signature, `certificationPermission` carries its DocMDP value (1 forbids changes, 2 allows form filling and signing, 3 also allows annotations). Saving rewrites the materialized bytes, so the stored signature stops covering the file and verification reports it as invalid; the original signature objects stay in the output as the record that the document was signed before it changed. Saving a certificated (P=1) document therefore asks for a second, explicit signature-loss confirmation in both the model approval and the Reader save sheet. Encrypted documents remain read-only for annotations unless the credential grants annotation permission, and an encrypted document that is also signed keeps that stricter path.

## Runtime ownership

`baseline-gateway.ts` converts authorized source bytes into immutable `BaselineResource` values and classifies acquisition failures; it owns neither credentials nor document identity. `registry.ts` is the sole owner of logical IDs, Reader/model references, operation pins, resident/suspended aggregates and in-memory credentials. `transitions.ts` coordinates durable effects and commits `record + baseline + snapshot` as one aggregate update. `service.ts` retains the single per-session transaction queue and command facade; `save.ts` retains the materialize/CAS/publish/cleanup transaction.

## Ownership and persistence

Reader references, model ownership, and internal operation pins are separate. A visible Reader baseline stays resident; inactive ordinary baselines may be released. `pdf_close` releases only the model reference; protected credentials and unpersisted protected operations end with the final owner. Draft persistence may store baseline bytes as an adapter strategy (including the V1 `baseKey` migration), but byte storage is not part of the logical model.

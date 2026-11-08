import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { adoptLegacyPageContents, pageContentAggregateKey } from '../../../../src/adapters/host/dsh/page-content-legacy.js'
import { appendPageRepresentation, buildNativePageContent, createPageRepresentation,
  NATIVE_PAGE_CONTENT_EXTRACTION_VERSION, pageContentBlockId, pageContentCacheIdentity, pageContentDigest, parsePageContent,
  type PageContent, type PageRepresentation } from '../../../../src/modules/document/index.js'
import type { RetrievalCache } from '../../../../src/modules/retrieval/index.js'
import type { NativeTextContent } from '../../../../src/shared/native.js'

type Target = Parameters<typeof adoptLegacyPageContents>[1]
const pipeline = 'page-content-v3-shared-vision-clean-1024-description-v1'
const rawDigest = pageContentDigest('exact original PDF file bytes')
const rect = [0, 0, 200, 300] as const
function target(change: Partial<Target> = {}): Target {
  return { pipeline, path: '/authorized/book.pdf', sourceDigest: rawDigest,
    indexContentDigest: pageContentDigest('stable printed page graph'), pageRects: [rect],
    extractionIdentity: 'current-runtime-fence', indexIdentity: 'accepted-durable-content-policy',
    scan: true, describe: true,
    ocr: { id: 'session-llm', fingerprint: 'new-ocr-model', reusable: true, explicitModel: false },
    image: { id: 'dsh-vision', fingerprint: 'new-image-model', reusable: true, explicitModel: false }, ...change }
}
function native(text = '', partial = false): NativeTextContent {
  return { items: text ? [{ str: text, transform: [10, 0, 0, 10, 10, 200], width: 100,
    height: 10, dir: 'ltr', fontName: 'fixture', hasEOL: false }] : [], styles: {}, lang: null,
    ...(partial ? { quality: { unmappedCharacters: 1 } } : {}) }
}
function legacy(options: { page?: number; text?: string; partialNative?: boolean; extraction?: string;
  ocr?: boolean; image?: boolean; ocrId?: string; imageId?: string; scope?: string } = {}): PageContent {
  let page = buildNativePageContent({ sourceDigest: rawDigest, page: options.page ?? 1, pageRect: [...rect],
    extractionIdentity: NATIVE_PAGE_CONTENT_EXTRACTION_VERSION, content: native(options.text, options.partialNative) })
  page = { ...page, extractionIdentity: options.extraction ?? 'old-session-scoped-selection' }
  if (options.ocr !== false) page = appendPageRepresentation(page,
    page.blocks.find(block => block.kind === (page.nativeText.text.trim() ? 'text' : 'visual-region'))!.id,
    createPageRepresentation({ kind: 'ocr-text', text: 'Previously recognized scanned text', status: 'complete',
      producer: { id: options.ocrId ?? 'session-llm', version: '1', model: 'historical-vision-model',
        configurationIdentity: options.scope ?? 'old-session-ocr' },
      inputDigest: pageContentDigest('the clean page pixels'), warnings: [] }))
  if (options.image !== false) page = appendPageRepresentation(page,
    page.blocks.find(block => block.kind === 'visual-region')!.id,
    createPageRepresentation({ kind: 'image-description', text: 'Previously generated chart description', status: 'complete',
      producer: { id: options.imageId ?? 'dsh-vision', version: '2', model: 'historical-vision-model',
        configurationIdentity: options.scope ?? 'old-session-image' },
      inputDigest: pageContentDigest('the clean page pixels'), warnings: [] }))
  assert.ok(parsePageContent(page), 'legacy fixtures must pass the actual persisted-page schema')
  return page
}
function storedKey(page: PageContent, change: { pipeline?: string; path?: string; digest?: string } = {}) {
  return pageContentAggregateKey(change.pipeline ?? pipeline, change.path ?? '/authorized/book.pdf',
    change.digest ?? page.sourceDigest, page.page, page.extractionIdentity)
}
const aggregate = (page: PageContent, plan: Target) => pageContentAggregateKey(plan.pipeline, plan.path,
  pageContentCacheIdentity({ sourceDigest: plan.sourceDigest, indexContentDigest: plan.indexContentDigest,
    indexPageDigest: plan.indexPageDigests?.[page.page - 1] }), page.page, plan.indexIdentity)
const marker = (plan: Target) => `pagecontent_adopted_${createHash('sha256')
  .update(JSON.stringify([plan.path, plan.indexContentDigest, plan.indexIdentity])).digest('hex')}`
const pageMarker = (plan: Target) => `pagecontent_adopted_pages_${createHash('sha256')
  .update(JSON.stringify([plan.pipeline, plan.path, plan.indexIdentity])).digest('hex')}`
const reps = (page: PageContent, kind?: PageRepresentation['kind']) => page.blocks.flatMap(block => block.representations)
  .filter(rep => !kind || rep.kind === kind)

function memory(entries: readonly (readonly [string, unknown])[] = [], chunkSize = 16) {
  const data = new Map(entries.map(([key, value]) => [key, structuredClone(value)]))
  const gets: string[] = [], writes: string[] = [], scans: { prefix: string; after?: string; limit: number }[] = []
  const hooks: { get?: (key: string) => void; scan?: () => void; write?: (key: string) => void } = {}
  const cache: RetrievalCache = {
    async get(key) { gets.push(key); const value = structuredClone(data.get(key)); hooks.get?.(key); return value },
    async set(key, value) { writes.push(key); data.set(key, structuredClone(value)); hooks.write?.(key) },
    async scan(prefix, after, limit = 16) {
      scans.push({ prefix, after, limit })
      const rows = [...data].filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      const selected = rows.slice(0, Math.min(chunkSize, limit))
      const result = { entries: structuredClone(selected), ...(rows.length > selected.length
        ? { nextKey: selected.at(-1)![0] } : {}) }
      hooks.scan?.(); return result
    },
  }
  return { data, gets, writes, scans, hooks, cache }
}

test('default legacy enrichments become a content-bound alias without changing producer evidence or old records', async () => {
  const old = legacy(), plan = target(), key = storedKey(old), f = memory([[key, old]])
  await adoptLegacyPageContents(f.cache, plan, () => {})
  const adopted = parsePageContent(f.data.get(aggregate(old, plan)))!
  assert.ok(adopted)
  assert.equal(adopted.sourceDigest, rawDigest)
  assert.equal(adopted.indexContentDigest, plan.indexContentDigest)
  assert.equal(adopted.extractionIdentity, plan.extractionIdentity)
  const blockIdentity = { ...adopted, extractionIdentity: NATIVE_PAGE_CONTENT_EXTRACTION_VERSION }
  for (const block of adopted.blocks) assert.equal(block.id, pageContentBlockId(blockIdentity,
    block.kind === 'visual-region' ? 'full-page-visual' : 'native-text'))
  assert.notDeepEqual(adopted.blocks.map(block => block.id), old.blocks.map(block => block.id))
  assert.deepEqual(reps(adopted), reps(old))
  assert.equal(adopted.blocks.find(block => block.kind === 'text')!.representations.some(rep => rep.kind === 'ocr-text'), false)
  assert.equal(adopted.blocks.find(block => block.kind === 'visual-region')!.representations.some(rep => rep.kind === 'ocr-text'), true)
  assert.deepEqual(f.data.get(key), old, 'adoption cannot rewrite another historical snapshot')
  assert.deepEqual(f.data.get(marker(plan)), { version: 1 })
  const counts = [f.scans.length, f.writes.length]
  await adoptLegacyPageContents(f.cache, plan, () => {})
  assert.deepEqual([f.scans.length, f.writes.length], counts, 'the accepted migration marker makes reopening idempotent')
})

test('page migration retains verified old results and scans once for each path and policy even after a source edit', async () => {
  const old = legacy(), unverifiable = legacy({ page: 2 })
  const plan = target({ indexContentDigest: undefined, indexPageDigests: [pageContentDigest('page one'), null], pageRects: [rect, rect] })
  const f = memory([[storedKey(old), old], [storedKey(unverifiable), unverifiable]])
  await adoptLegacyPageContents(f.cache, plan, () => {})
  const adopted = parsePageContent(f.data.get(aggregate(old, plan)))!
  assert.equal(adopted.indexPageDigest, plan.indexPageDigests![0])
  assert.equal(adopted.indexContentDigest, undefined)
  assert.deepEqual(reps(adopted), reps(old))
  assert.equal(f.data.has(aggregate(unverifiable, plan)), false)
  assert.deepEqual(f.data.get(pageMarker(plan)), { version: 1 })
  const scans = f.scans.length, writes = f.writes.length

  const changed = target({ ...plan, sourceDigest: pageContentDigest('edited file'), indexContentDigest: pageContentDigest('new whole document'),
    indexPageDigests: [plan.indexPageDigests![0]!, pageContentDigest('edited second page')] })
  await adoptLegacyPageContents(f.cache, changed, () => {})
  assert.equal(aggregate(old, changed), aggregate(old, plan))
  assert.deepEqual([f.scans.length, f.writes.length], [scans, writes])

  const anotherPolicy = target({ ...changed, indexIdentity: 'another plan' })
  await adoptLegacyPageContents(f.cache, anotherPolicy, () => {})
  assert.ok(f.scans.length > scans)
  assert.equal(f.data.has(aggregate(old, anotherPolicy)), false, 'a scan of the edited file cannot adopt the previous raw source')
  assert.deepEqual(f.data.get(pageMarker(anotherPolicy)), { version: 1 })
})

test('an existing whole-document completion marker avoids rescanning for the same verified document', async () => {
  const old = legacy(), whole = target(), f = memory([[storedKey(old), old]])
  await adoptLegacyPageContents(f.cache, whole, () => {})
  const aliases = f.writes.length, scans = f.scans.length
  const perPage = target({ ...whole, sourceDigest: pageContentDigest('resaved same document'),
    indexPageDigests: [pageContentDigest('same page')] })
  await adoptLegacyPageContents(f.cache, perPage, () => {})
  assert.equal(f.scans.length, scans)
  assert.deepEqual(f.writes.slice(aliases), [pageMarker(perPage)])
  assert.equal(f.data.has(aggregate(old, perPage)), false, 'verified whole-document aliases are read through lazily')
  assert.deepEqual(reps(parsePageContent(f.data.get(aggregate(old, whole)))!), reps(old))
})

test('page migration preserves an existing verified aggregate', async () => {
  const old = legacy(), plan = target({ indexPageDigests: [pageContentDigest('same page')] })
  const alias = aggregate(old, plan), current = { version: 'concurrently stored' }
  const f = memory([[storedKey(old), old], [alias, current]])
  await adoptLegacyPageContents(f.cache, plan, () => {})
  assert.deepEqual(f.data.get(alias), current)
  assert.deepEqual(f.writes, [pageMarker(plan)])
})

test('partial native text retains OCR on its text block while disabled enrichments are omitted', async () => {
  const old = legacy({ text: 'Some native text', partialNative: true }), plan = target({ describe: false })
  const f = memory([[storedKey(old), old]])
  await adoptLegacyPageContents(f.cache, plan, () => {})
  const adopted = parsePageContent(f.data.get(aggregate(old, plan)))!
  assert.deepEqual(reps(adopted, 'ocr-text'), reps(old, 'ocr-text'))
  assert.equal(adopted.blocks.find(block => block.kind === 'text')!.representations.some(rep => rep.kind === 'ocr-text'), true)
  assert.deepEqual(reps(adopted, 'image-description'), [])
  const nativeOnly = memory([[storedKey(old), old]]), nativePlan = target({ scan: false, describe: false })
  await adoptLegacyPageContents(nativeOnly.cache, nativePlan, () => {})
  assert.deepEqual(reps(parsePageContent(nativeOnly.data.get(aggregate(old, nativePlan)))!), reps(old, 'native-text'))
})

test('scanning streams bounded hex ranges, preserves unrelated layers and adopts at most one snapshot per page', async () => {
  const plans = target({ pageRects: Array.from({ length: 24 }, () => rect) })
  const pages = Array.from({ length: 24 }, (_, index) => legacy({ page: index + 1 }))
  const duplicate = legacy({ page: 1, extraction: 'a different old session' })
  const layer = { sentinel: 'unrelated source layer' }
  const f = memory([...pages.map(page => [storedKey(page), page] as const), [storedKey(duplicate), duplicate],
    ['pagecontent_native_do-not-read', layer]], 2)
  await adoptLegacyPageContents(f.cache, plans, () => {})
  assert.equal(f.writes.filter(key => key !== marker(plans)).length, 24)
  for (const page of pages) assert.ok(parsePageContent(f.data.get(aggregate(page, plans))))
  assert.deepEqual(f.data.get('pagecontent_native_do-not-read'), layer)
  assert.deepEqual([...new Set(f.scans.map(call => call.prefix))], [...'0123456789abcdef'].map(digit => `pagecontent_${digit}`))
  assert.ok(f.scans.some(call => call.after !== undefined), 'multiple read windows must actually be exercised')
  assert.ok(f.scans.every(call => call.limit === 16 && /^pagecontent_[a-f0-9]$/.test(call.prefix)))
  assert.deepEqual(f.gets, [marker(plans)], 'layer payloads are never loaded through the migration get path')
})

test('foreign paths, source bytes, pages, geometry, pipeline or forged keys are not treated as ownership evidence', async t => {
  const cases = ['path', 'source', 'page', 'geometry', 'pipeline', 'forged-key', 'new-format', 'invalid'] as const
  for (const kind of cases) await t.test(kind, async () => {
    const old = legacy(), plan = target()
    let value: unknown = old, key = storedKey(old)
    if (kind === 'path') key = storedKey(old, { path: '/another/private.pdf' })
    if (kind === 'source') { old.sourceDigest = pageContentDigest('different source'); key = storedKey(old) }
    if (kind === 'page') { old.page = 2; key = storedKey(old) }
    if (kind === 'geometry') old.pageRect = [0, 0, 199, 300]
    if (kind === 'pipeline') key = storedKey(old, { pipeline: 'an incompatible renderer pipeline' })
    if (kind === 'forged-key') key = `pagecontent_${'0'.repeat(64)}`
    if (kind === 'new-format') old.indexContentDigest = plan.indexContentDigest
    if (kind === 'invalid') value = { arbitrary: 'not a validated PageContent' }
    const f = memory([[key, value]])
    await adoptLegacyPageContents(f.cache, plan, () => {})
    assert.equal(f.data.has(aggregate(old, plan)), false)
    assert.deepEqual(f.writes, [marker(plan)])
    assert.deepEqual(f.data.get(key), value)
  })
})

test('failures, obsolete extraction, missing native structure and incomplete requested enrichments are never adopted', async t => {
  const cases = ['failure', 'obsolete-native', 'foreign-native', 'no-native', 'extra-block',
    'no-text-block', 'no-visual-block', 'no-ocr', 'no-image', 'partial-ocr', 'partial-image'] as const
  for (const kind of cases) await t.test(kind, async () => {
    const old = legacy(), plan = target()
    if (kind === 'failure') old.failure = { code: 'pdf/ocr-failed' }
    if (kind === 'obsolete-native') reps(old, 'native-text')[0]!.producer.version = 'an obsolete native extractor'
    if (kind === 'foreign-native') reps(old, 'native-text')[0]!.producer.id = 'a foreign extraction source'
    if (kind === 'no-native') old.blocks.forEach(block => { block.representations = block.representations.filter(rep => rep.kind !== 'native-text') })
    if (kind === 'extra-block') old.blocks.push({ id: `pdfblock_${'f'.repeat(64)}`, kind: 'unknown', representations: [] })
    if (kind === 'no-text-block') old.blocks.find(block => block.kind === 'text')!.kind = 'table'
    if (kind === 'no-visual-block') old.blocks.find(block => block.kind === 'visual-region')!.kind = 'unknown'
    if (kind === 'no-ocr' || kind === 'no-image') old.blocks.forEach(block => {
      block.representations = block.representations.filter(rep => rep.kind !== (kind === 'no-ocr' ? 'ocr-text' : 'image-description'))
    })
    if (kind === 'partial-ocr') reps(old, 'ocr-text')[0]!.status = 'partial'
    if (kind === 'partial-image') reps(old, 'image-description')[0]!.status = 'partial'
    assert.ok(parsePageContent(old), 'rejections must test semantically ineligible but structurally valid snapshots')
    const f = memory([[storedKey(old), old]])
    await adoptLegacyPageContents(f.cache, plan, () => {})
    assert.deepEqual(f.writes, [marker(plan)])
  })
})

test('only default reusable follow-session engines may bridge a different legacy runtime fingerprint', async t => {
  for (const kind of ['ocr', 'image'] as const) for (const setting of ['private', 'third-party', 'pinned', 'missing-fingerprint'] as const) {
    await t.test(`${kind}: ${setting}`, async () => {
      const old = legacy(), plan = target()
      const selected = { ...plan[kind] }
      if (setting === 'private') selected.reusable = false
      if (setting === 'third-party') {
        selected.id = 'third-party-engine'
        reps(old, kind === 'ocr' ? 'ocr-text' : 'image-description')[0]!.producer.id = selected.id
      }
      if (setting === 'pinned') selected.explicitModel = true
      if (setting === 'missing-fingerprint') {
        selected.id = 'private-engine'; selected.reusable = false; delete selected.fingerprint
        const producer = reps(old, kind === 'ocr' ? 'ocr-text' : 'image-description')[0]!.producer
        producer.id = selected.id; delete producer.configurationIdentity
      }
      plan[kind] = selected
      const f = memory([[storedKey(old), old]])
      await adoptLegacyPageContents(f.cache, plan, () => {})
      assert.deepEqual(f.writes, [marker(plan)])
    })
  }
})

test('an exact private fingerprint or explicitly pinned model remains adoptable only in its original scope', async () => {
  for (const kind of ['ocr', 'image'] as const) for (const explicitModel of [false, true]) {
    const old = legacy(), plan = target()
    const representation = reps(old, kind === 'ocr' ? 'ocr-text' : 'image-description')[0]!
    plan[kind] = { id: 'third-party-engine', reusable: false, explicitModel,
      fingerprint: representation.producer.configurationIdentity }
    representation.producer.id = 'third-party-engine'
    const f = memory([[storedKey(old), old]])
    await adoptLegacyPageContents(f.cache, plan, () => {})
    assert.deepEqual(reps(parsePageContent(f.data.get(aggregate(old, plan)))!, representation.kind), [representation])
    const other = target({ ...plan, indexIdentity: 'another scope', [kind]: { ...plan[kind], fingerprint: 'different-private-scope' } })
    const g = memory([[storedKey(old), old]])
    await adoptLegacyPageContents(g.cache, other, () => {})
    assert.equal(g.data.has(aggregate(old, other)), false)
  }
})

test('cancellation or source replacement during scanning prevents alias and completion writes', async () => {
  for (const phase of ['get', 'scan', 'entry-check'] as const) {
    const old = legacy(), plan = target(), f = memory([[storedKey(old), old]])
    const controller = new AbortController(), stale = Object.assign(new Error('source no longer authorized'), { code: 'pdf/stale-reader' })
    let entriesReturned = false, batchChecks = 0
    const scan = f.cache.scan!
    f.cache.scan = async (...args) => {
      const batch = await scan(...args)
      entriesReturned = batch.entries.length > 0; batchChecks = 0
      return batch
    }
    const check = () => {
      if (entriesReturned && ++batchChecks === 2 && phase === 'entry-check') controller.abort(stale)
      controller.signal.throwIfAborted()
    }
    if (phase === 'get') f.hooks.get = () => controller.abort(stale)
    if (phase === 'scan') f.hooks.scan = () => controller.abort(stale)
    await assert.rejects(adoptLegacyPageContents(f.cache, plan, check), error => error === stale)
    assert.deepEqual(f.writes, [])
  }
})

test('source and cancellation fences are rechecked after both alias and completion-marker writes', async () => {
  for (const after of ['alias', 'marker'] as const) {
    const old = legacy(), plan = target(), f = memory([[storedKey(old), old]])
    const stale = Object.assign(new Error('source changed after I/O'), { code: 'pdf/stale-reader' })
    let changed = false
    f.hooks.write = key => { if ((key === marker(plan)) === (after === 'marker')) changed = true }
    await assert.rejects(adoptLegacyPageContents(f.cache, plan, () => { if (changed) throw stale }), error => error === stale)
    assert.ok(f.data.has(aggregate(old, plan)), 'a completed derived-data write is not undone by a later cancellation')
    assert.equal(f.data.has(marker(plan)), after === 'marker')
    assert.deepEqual(f.data.get(storedKey(old)), old)
  }
})

test('migration rejects non-advancing, backwards and out-of-range scan cursors instead of looping', async () => {
  for (const mode of ['same', 'backwards', 'outside'] as const) {
    const plan = target(), f = memory()
    let calls = 0
    f.cache.scan = async (prefix, cursor) => {
      calls++
      return { entries: [], nextKey: mode === 'outside' ? 'not-the-requested-prefix'
        : cursor === undefined ? `${prefix}f` : mode === 'same' ? cursor : `${prefix}a` }
    }
    await assert.rejects(adoptLegacyPageContents(f.cache, plan, () => {}), /cursor did not advance/)
    assert.ok(calls <= 2); assert.deepEqual(f.writes, [])
  }
})

test('a cache without scanning is untouched; only the supported completion marker skips future scans', async () => {
  const plan = target(), unsupported = memory()
  delete unsupported.cache.scan
  await adoptLegacyPageContents(unsupported.cache, plan, () => {})
  assert.deepEqual([unsupported.gets.length, unsupported.writes.length, unsupported.scans.length], [0, 0, 0])
  const completed = memory([[marker(plan), { version: 1 }]])
  await adoptLegacyPageContents(completed.cache, plan, () => {})
  assert.deepEqual(completed.scans, []); assert.deepEqual(completed.writes, [])
  for (const value of [null, 1, { version: 2 }]) {
    const unrecognized = memory([[marker(plan), value]])
    await adoptLegacyPageContents(unrecognized.cache, plan, () => {})
    assert.equal(unrecognized.scans.length, 16)
    assert.deepEqual(unrecognized.data.get(marker(plan)), { version: 1 })
  }
})

test('storage failures do not claim that an incomplete migration succeeded', async () => {
  for (const operation of ['get', 'scan', 'set'] as const) {
    const old = legacy(), plan = target(), f = memory([[storedKey(old), old]])
    const failure = new Error(`storage ${operation} failed`)
    f.cache[operation] = async () => { throw failure }
    await assert.rejects(adoptLegacyPageContents(f.cache, plan, () => {}), error => error === failure)
    assert.equal(f.data.has(marker(plan)), false)
    assert.deepEqual(f.data.get(storedKey(old)), old)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { actionableLink, createLinkHitTester, linkAtPoint, namedLinkAction, safeLinkUrl, type PdfLink } from '../src/client/reader-links.ts'
import type { PageViewport } from '../src/client/reader-selection.ts'

const identityViewport = {
  convertToPdfPoint: (x: number, y: number) => [x, y],
} as unknown as PageViewport

const quad = (left: number, bottom: number, right: number, top: number) => [
  left, bottom, right, bottom, left, top, right, top,
]

test('PDF link actions accept only supported named actions and safe external URLs', () => {
  assert.equal(namedLinkAction('NextPage'), true)
  assert.equal(namedLinkAction('LastPage'), true)
  assert.equal(namedLinkAction('Launch'), false)
  assert.equal(namedLinkAction(undefined), false)

  assert.equal(safeLinkUrl('https://example.org/doc'), 'https://example.org/doc')
  assert.equal(safeLinkUrl('mailto:reader@example.org'), 'mailto:reader@example.org')
  assert.equal(safeLinkUrl('javascript:alert(1)'), undefined)
  assert.equal(safeLinkUrl('file:///private/test.pdf'), undefined)
  assert.equal(safeLinkUrl('not a URL'), undefined)
  assert.equal(safeLinkUrl(undefined), undefined)

  assert.equal(actionableLink({ id: 'destination', rect: [0, 0, 1, 1], dest: [3] }), true)
  assert.equal(actionableLink({ id: 'named', rect: [0, 0, 1, 1], action: 'PrevPage' }), true)
  assert.equal(actionableLink({ id: 'external', rect: [0, 0, 1, 1], url: 'http://example.org' }), true)
  assert.equal(actionableLink({ id: 'unsafe', rect: [0, 0, 1, 1], url: 'javascript:alert(1)' }), false)
})

test('scanned and indexed hit tests agree on geometry, overlap order, and coordinate conversion', () => {
  const links: PdfLink[] = [
    { id: 'ignored', rect: [0, 0, 30, 30] },
    { id: 'invalid-shape', rect: [0, 0, 30], dest: 'x' },
    { id: 'invalid-number', rect: [0, 0, NaN, 30], dest: 'x' },
    { id: 'broad', rect: [30, 30, 0, 0], dest: 'broad' },
    { id: 'quads', rect: [0, 0, 30, 30], quadPoints: [...quad(0, 0, 10, 10), ...quad(20, 20, 30, 30)], dest: 'quads' },
    { id: 'fallback-quad', rect: [0, 0, 10, 10], quadPoints: [0, 0, 1], dest: 'fallback' },
  ]
  const indexed = createLinkHitTester(links)
  for (const point of [[5, 5], [15, 15], [25, 25], [30, 30], [-1, 5], [40, 40]] as [number, number][]) {
    assert.equal(indexed(identityViewport, point)?.id, linkAtPoint(links, identityViewport, point)?.id)
  }
  assert.equal(indexed(identityViewport, [5, 5])?.id, 'fallback-quad')
  assert.equal(indexed(identityViewport, [15, 15])?.id, 'broad')
  assert.equal(indexed(identityViewport, [25, 25])?.id, 'quads')
  assert.equal(indexed(identityViewport, [40, 40]), undefined)

  const offsetViewport = {
    convertToPdfPoint: (x: number, y: number) => [x - 100, y + 20],
  } as unknown as PageViewport
  assert.equal(indexed(offsetViewport, [125, 5])?.id, 'quads')
  assert.equal(linkAtPoint(links, offsetViewport, [125, 5])?.id, 'quads')
})

test('quad hit testing excludes empty margins, degenerate polygons and respects last-drawn links', () => {
  const links: PdfLink[] = [
    { id: 'under', rect: [0, 0, 40, 40], dest: 'under' },
    { id: 'quad', rect: [0, 0, 40, 40], quadPoints: quad(0, 0, 10, 10), dest: 'quad' },
    { id: 'degenerate', rect: [0, 0, 40, 40], quadPoints: [0, 0, 1, 0, 2, 0, 3, 0], dest: 'bad' },
  ]
  const indexed = createLinkHitTester(links)
  assert.equal(indexed(identityViewport, [5, 5])?.id, 'quad')
  assert.equal(linkAtPoint(links, identityViewport, [5, 5])?.id, 'quad')
  assert.equal(indexed(identityViewport, [20, 20])?.id, 'under')
  assert.equal(linkAtPoint(links, identityViewport, [20, 20])?.id, 'under')
  assert.equal(indexed(identityViewport, [41, 41]), undefined)
})

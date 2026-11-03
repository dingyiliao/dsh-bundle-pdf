import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import {
  PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull,
  PDFNumber, PDFObject, PDFRef, PDFStream, PDFString,
} from 'pdf-lib'

interface ContentIdentityLimits {
  maxObjects?: number
  maxBytes?: number
  maxDepth?: number
  maxStreamBytes?: number
}

const name = PDFName.of
const resourceCategories = new Set(['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties'])
const operators = new Set(('q Q cm w J j M d ri i gs m l c v y h re S s f F f* B B* b b* n W W* '
  + 'BT ET Tc Tw Tz TL Tf Tr Ts Td TD Tm T* Tj TJ \' " d0 d1 CS cs SC SCN sc scn G g RG rg K k '
  + 'sh Do MP DP BMC BDC EMC BX EX true false null').split(' '))
const white = (byte: number) => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32
const delimiter = (byte: number) => white(byte) || [37, 40, 41, 47, 60, 62, 91, 93, 123, 125].includes(byte)

/** A bounded lexer for one equivalence only: pdf-lib's outer q / Q wrappers. */
function balancedGraphicsState(program: Uint8Array): boolean {
  const containers: number[] = []
  let index = 0, saves = 0
  while (index < program.length) {
    const byte = program[index++]!
    if (white(byte)) continue
    if (byte === 37) {
      while (index < program.length && program[index] !== 10 && program[index] !== 13) index++
    } else if (byte === 40) {
      let nesting = 1
      while (index < program.length && nesting) {
        const next = program[index++]!
        if (next === 92) { if (index >= program.length) return false; index++ }
        else if (next === 40) nesting++
        else if (next === 41) nesting--
      }
      if (nesting) return false
    } else if (byte === 47) {
      while (index < program.length && !delimiter(program[index]!)) index++
    } else if (byte === 60 && program[index] !== 60) {
      while (index < program.length && program[index] !== 62) {
        const hex = program[index++]!
        if (!white(hex) && !(hex >= 48 && hex <= 57 || hex >= 65 && hex <= 70 || hex >= 97 && hex <= 102)) return false
      }
      if (index >= program.length) return false
      index++
    } else if (byte === 91 || byte === 60) {
      if (byte === 60) index++
      containers.push(byte)
      if (containers.length > 64) return false
    } else if (byte === 93 || byte === 62) {
      if (containers.pop() !== (byte === 93 ? 91 : 60)) return false
      if (byte === 62 && program[index++] !== 62) return false
    } else {
      if (delimiter(byte)) return false
      const start = index - 1
      while (index < program.length && !delimiter(program[index]!)) index++
      if (containers.length) continue
      const token = Buffer.from(program.subarray(start, index)).toString('latin1')
      if (!operators.has(token) && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) return false
      if (token === 'q') saves++
      if (token === 'Q' && --saves < 0) return false
    }
  }
  return saves === 0 && containers.length === 0
}

/**
 * Page programs, resources and inherited geometry, independent of annotations,
 * metadata, object numbers, dictionary order and resource sharing. Unsupported
 * or cyclic graphs and bounded-work failures retain the conservative byte-hash
 * path instead of preventing an otherwise readable PDF from opening.
 */
export function pdfIndexContentDigest(document: PDFDocument, limits: ContentIdentityLimits = {}): string | undefined {
  const maxObjects = limits.maxObjects ?? 500_000
  const maxBytes = limits.maxBytes ?? 256 * 1024 * 1024
  const maxDepth = limits.maxDepth ?? 64
  const maxStreamBytes = limits.maxStreamBytes ?? 32 * 1024 * 1024
  const memo = new Map<PDFObject, string>(), active = new Set<PDFObject>()
  const groups = new Map<PDFObject, number>()
  let objects = 0, bytes = 0

  function node(kind: string, parts: readonly string[], payload?: Uint8Array): string {
    const hash = createHash('sha256')
    for (const part of [kind, ...parts]) {
      const size = Buffer.byteLength(part)
      bytes += size
      if (bytes > maxBytes) throw new Error('PDF content identity byte budget exceeded')
      hash.update(`${size}:`); hash.update(part)
    }
    if (payload) {
      bytes += payload.byteLength
      if (bytes > maxBytes) throw new Error('PDF content identity byte budget exceeded')
      hash.update(`payload:${payload.byteLength}:`); hash.update(payload)
    }
    return hash.digest('hex')
  }
  function lookup(value: PDFObject | undefined): PDFObject | undefined {
    const resolved = document.context.lookup(value)
    if (value instanceof PDFRef && !resolved) throw new Error('Unresolved PDF content reference')
    return resolved
  }
  function dictionary(value: PDFDict, depth: number, omit = new Set<string>()): string {
    const parts: string[] = []
    const entries = value.entries().map(([key, child]) => [key.decodeText(), child] as const)
      .filter(([key]) => key !== 'Metadata' && !omit.has(key))
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    for (const [key, child] of entries) parts.push(key, visit(child, depth + 1))
    return node('dictionary', parts)
  }
  function visit(raw: PDFObject | undefined, depth = 0): string {
    if (++objects > maxObjects || depth > maxDepth) throw new Error('PDF content identity traversal budget exceeded')
    const value = lookup(raw)
    if (value === undefined || value === PDFNull) return 'null'
    if (value instanceof PDFName) return `name:${value.decodeText()}`
    if (value instanceof PDFNumber) {
      const number = value.asNumber()
      if (!Number.isFinite(number)) throw new Error('Invalid PDF content number')
      return `number:${number === 0 ? 0 : number}`
    }
    if (value instanceof PDFBool) return `boolean:${value.asBoolean()}`
    if (value instanceof PDFString || value instanceof PDFHexString) return node('string', [], value.asBytes())
    if (!(value instanceof PDFArray || value instanceof PDFDict || value instanceof PDFStream)) {
      throw new Error('Unsupported PDF content object')
    }
    if (active.has(value)) throw new Error('Cyclic PDF content resource graph')
    const previous = memo.get(value)
    if (previous !== undefined) return previous
    active.add(value)
    let result: string
    if (value instanceof PDFArray) {
      const parts: string[] = []
      for (let index = 0; index < value.size(); index++) parts.push(visit(value.get(index), depth + 1))
      result = node('array', parts)
    } else if (value instanceof PDFStream) {
      let contents = value.getContents()
      if (contents.byteLength > maxStreamBytes) throw new Error('PDF content stream budget exceeded')
      const filter = lookup(value.dict.get(name('Filter')))
      const single = filter instanceof PDFArray && filter.size() === 1 ? lookup(filter.get(0)) : filter
      const flate = single instanceof PDFName && ['FlateDecode', 'Fl'].includes(single.decodeText())
      if (flate || filter === undefined || filter === PDFNull) {
        if (flate) contents = inflateSync(contents, { maxOutputLength: Math.min(maxStreamBytes, maxBytes - bytes) })
        const parameters = lookup(value.dict.get(name('DecodeParms')))
        // Predictors remain significant after Flate decompression.
        result = node('decoded-stream', [dictionary(value.dict, depth, new Set(['Length', 'Filter', 'DecodeParms'])),
          visit(parameters instanceof PDFArray && parameters.size() === 1 ? parameters.get(0) : parameters, depth + 1)], contents)
      } else result = node('encoded-stream', [dictionary(value.dict, depth, new Set(['Length']))], contents)
    } else {
      const type = lookup(value.get(name('Type')))
      if (type instanceof PDFName && ['Page', 'Pages', 'Catalog'].includes(type.decodeText())) {
        throw new Error('PDF resources refer back into the document container')
      }
      if (type instanceof PDFName && type.decodeText() === 'OCG') {
        const index = groups.get(value)
        if (index === undefined) throw new Error('Unregistered optional-content group')
        // Two identical OCG dictionaries may have distinct ON/OFF membership.
        result = node('optional-content-group', [String(index), dictionary(value, depth)])
      } else result = dictionary(value, depth)
    }
    active.delete(value); memo.set(value, result)
    return result
  }
  function resources(value: PDFDict | undefined): string {
    const normalized = PDFDict.withContext(document.context)
    for (const [key, child] of value?.entries() ?? []) {
      const category = key.decodeText()
      if (category === 'ProcSet') continue
      if (!resourceCategories.has(category)) throw new Error('Unsupported PDF resource category')
      const resolved = lookup(child)
      // pdf-lib may materialize these empty containers while touching annotations.
      if (!(resolved instanceof PDFDict && resolved.entries().length === 0)) normalized.set(key, child)
    }
    return visit(normalized)
  }
  function pageStreams(contents: PDFArray | PDFStream | undefined): PDFObject[] {
    let streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
    // Loaded pages can gain distinct "q\n" and "Q\n" streams when pdf-lib
    // normalizes their annotation array. Strip only that proven outer wrapper;
    // inline images, unknown operators and malformed syntax remain conservative.
    function decoded(raw: PDFObject, limit: number): Uint8Array | undefined {
      const stream = lookup(raw)
      if (!(stream instanceof PDFStream)) return undefined
      const filter = lookup(stream.dict.get(name('Filter')))
      const parameters = lookup(stream.dict.get(name('DecodeParms')))
      if (parameters !== undefined && parameters !== PDFNull) return undefined
      let bytes = stream.getContents()
      if (filter instanceof PDFName && filter.decodeText() === 'FlateDecode') {
        bytes = inflateSync(bytes, { maxOutputLength: limit })
      } else if (filter !== undefined && filter !== PDFNull) return undefined
      return bytes.length <= limit ? bytes : undefined
    }
    function wrapper(raw: PDFObject, operator: number): boolean {
      const bytes = decoded(raw, 128)
      if (!bytes) return false
      let first = 0, last = bytes.length
      while (first < last && white(bytes[first]!)) first++
      while (last > first && white(bytes[last - 1]!)) last--
      return last === first + 1 && bytes[first] === operator
    }
    try {
      while (streams.length >= 2 && wrapper(streams[0]!, 113) && wrapper(streams[streams.length - 1]!, 81)) {
        const parts: Uint8Array[] = []
        let size = 0
        for (const stream of streams.slice(1, -1)) {
          const data = decoded(stream, maxStreamBytes - size)
          if (!data) return streams
          size += data.length + 1
          if (size > maxStreamBytes) return streams
          parts.push(data, new Uint8Array([10]))
        }
        if (!balancedGraphicsState(Buffer.concat(parts))) return streams
        streams = streams.slice(1, -1)
      }
    } catch { /* Unsupported wrapper decoding does not invalidate the graph identity. */ }
    return streams
  }

  try {
    const optional = lookup(document.catalog.get(name('OCProperties')))
    if (optional instanceof PDFDict) {
      const array = lookup(optional.get(name('OCGs')))
      if (array instanceof PDFArray) for (let index = 0; index < array.size(); index++) {
        const group = lookup(array.get(index))
        if (!group || groups.has(group)) throw new Error('Ambiguous optional-content groups')
        groups.set(group, index)
      }
    }
    const pages = document.getPages(), parts = [visit(optional), visit(document.catalog.get(name('OutputIntents')))]
    for (const page of pages) {
      const media = page.getMediaBox(), crop = page.getCropBox()
      const geometry = [media.x, media.y, media.width, media.height, crop.x, crop.y, crop.width, crop.height,
        page.getRotation().angle]
      if (!geometry.every(Number.isFinite)) throw new Error('Invalid PDF content geometry')
      // A stream and a one-element stream array execute the same page program.
      const streams = pageStreams(page.node.Contents())
      parts.push(node('page', [JSON.stringify(geometry), visit(page.node.get(name('UserUnit')) ?? document.context.obj(1)),
        visit(page.node.get(name('Group'))), resources(page.node.Resources()), node('contents', streams.map(stream => visit(stream)))]))
    }
    return `sha256:${node('pdf-index-content-v1', parts)}`
  } catch { return undefined }
}

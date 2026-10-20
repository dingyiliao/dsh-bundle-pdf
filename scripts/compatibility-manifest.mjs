import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

async function source(path) {
  const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, child => visit(child, callback))
}

function property(object, key) {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined
  return object.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(object.getSourceFile()) === key)?.initializer
}

function literal(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text
  return undefined
}

function exportedConstant(file, name) {
  let value
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(file) === name) value = declaration.initializer
    }
  }
  if (value === undefined) throw new Error(`Missing exported constant ${name} in ${file.fileName}`)
  return value
}

function stringArray(node) {
  if (!node || !ts.isArrayLiteralExpression(node)) throw new Error('Expected a literal string array')
  return node.elements.map(item => {
    const value = literal(item)
    if (value === undefined) throw new Error('Expected a literal string array')
    return value
  })
}

function plugin(file) {
  const result = { name: literal(exportedConstant(file, 'name')) }
  if (!result.name) throw new Error(`Missing plugin name in ${file.fileName}`)
  try { result.provide = literal(exportedConstant(file, 'provide')) } catch (error) {
    if (!String(error).includes('Missing exported constant')) throw error
  }
  try { result.inject = stringArray(exportedConstant(file, 'inject')) } catch (error) {
    if (!String(error).includes('Missing exported constant')) throw error
  }
  return result
}

function calls(file, functionName) {
  const matches = []
  visit(file, node => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === functionName) matches.push(node)
  })
  return matches
}

function verifyV1KeyAlgorithms(drafts, navigation) {
  const compact = file => file.text.replace(/\s+/g, '')
  const draft = compact(drafts)
  const nav = compact(navigation)
  for (const file of [drafts, navigation]) {
    if (!compact(file).includes("process.platform==='win32'?path.toLowerCase():path")) {
      throw new Error(`V1 path normalization changed in ${file.fileName}`)
    }
  }
  if (!draft.includes("createHash('sha256').update(JSON.stringify([sessionId,normalizedPath(path)])).digest('hex')")
    || !draft.includes('`base_${key(record.sessionId,record.path)}_${record.sourceHash.slice(7)}`')) {
    throw new Error('V1 draft/baseline key algorithm changed; migrate stored drafts deliberately')
  }
  if (!nav.includes("createHash('sha256').update(normalizedPath(path)).digest('hex')")) {
    throw new Error('V1 bookmark/reading-position key algorithm changed; migrate stored navigation deliberately')
  }
  // These signatures describe persistent behavior, not the names of local
  // functions. The V1 fixture tests exercise the same algorithms on records.
  return {
    path: "process.platform==='win32'?path.toLowerCase():path",
    draft: "createHash('sha256').update(JSON.stringify([session,pathKey(path)])).digest('hex')",
    baseline: '`base_${recordKey(record.sessionId,record.path)}_${record.sourceHash.slice(7)}`',
    bookmark: "createHash('sha256').update(pathKey(path)).digest('hex')",
    readingPosition: "createHash('sha256').update(pathKey(path)).digest('hex')",
  }
}

function storageDomain(call, file) {
  const definition = call.arguments[0]
  const name = property(definition, 'name')
  const version = property(definition, 'version')
  const layout = property(definition, 'layout')
  const tables = property(definition, 'tables')
  if (!name || !ts.isTemplateExpression(name) || !version || !ts.isNumericLiteral(version)
    || !tables || !ts.isObjectLiteralExpression(tables)) {
    throw new Error(`Unexpected V1 storage declaration in ${file.fileName}`)
  }
  return {
    name: name.getText(file).slice(1, -1),
    version: Number(version.text),
    layout: literal(layout),
    tables: tables.properties.map(item => item.name?.getText(file)),
  }
}

function patchEntries(text) {
  const entries = [...text.matchAll(/^\s+- id: ([\w-]+)\s*\n\s+name: ['"]([^'"]+)['"]/gm)]
    .map(match => ({ id: match[1], name: match[2] }))
  if (!entries.length || (text.match(/^\s+- id:/gm) ?? []).length !== entries.length) {
    throw new Error('Cannot read all Cordis patch entries; update the manifest parser before changing the patch')
  }
  return entries
}

/** Capture public identities. Run `node scripts/compatibility-manifest.mjs` to inspect a proposed change. */
export async function collectCompatibilityManifest() {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = patchEntries(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const [reader, native, ocr, image, client, transport, infoRoute, tools, modelWriteTools, ocrTool, drafts, navigation] = await Promise.all([
    source('src/entrypoints/reader-host.ts'), source('src/entrypoints/native-host.ts'), source('src/entrypoints/ocr-host.ts'),
    source('src/entrypoints/image-understanding-host.ts'), source('src/entrypoints/reader-client.tsx'),
    source('src/contracts/rpc/envelope.ts'), source('src/adapters/host/dsh/info-route.ts'),
    source('src/adapters/host/dsh/agent-tools.ts'), source('src/adapters/host/dsh/model-write-tools.ts'),
    source('src/adapters/host/dsh/ocr-tool.ts'),
    source('src/adapters/host/storage/v1-drafts.ts'), source('src/adapters/host/storage/v1-navigation.ts'),
  ])
  const endpoints = [literal(exportedConstant(transport, 'PDF_ENDPOINT'))]
  for (const file of [reader, image]) {
    for (const call of calls(file, 'registerPdfTransport')) {
      if (call.arguments.length < 3) continue
      const endpoint = literal(property(call.arguments[2], 'endpoint'))
      if (!endpoint) throw new Error(`Cannot determine RPC endpoint in ${file.fileName}`)
      endpoints.push(endpoint)
    }
  }
  // `pdf.info` is the one Connection fetch route that deliberately has no resource session.
  const infoPaths = []
  visit(infoRoute, node => {
    if (!ts.isPropertyAssignment(node) || node.name.getText(infoRoute) !== 'path') return
    const path = literal(node.initializer)
    if (path?.startsWith('/api/pdf.')) infoPaths.push(path)
  })
  if (infoPaths.length !== 1) throw new Error(`Cannot determine PDF info route in ${infoRoute.fileName}`)
  endpoints.push(infoPaths[0].slice('/api/'.length))
  const toolNames = []
  for (const file of [tools, modelWriteTools, ocrTool]) {
    for (const call of calls(file, 'defineTool')) {
      const name = literal(property(call.arguments[0], 'name'))
      if (!name) throw new Error(`Cannot determine tool name in ${file.fileName}`)
      toolNames.push(name)
    }
  }
  const reflectedServices = calls(reader, 'ctx.reflect.provide').map(call => literal(call.arguments[0]))
  const clientSlots = calls(client, 'ctx.slots.inject').map(call => literal(call.arguments[0]))
  const preview = calls(client, 'ctx.documentPreviews.register')[0]
  if (!preview) throw new Error('Missing Client document preview registration')
  if (!/createHash\('sha256'\)\.update\(namespace\)\.digest\('hex'\)\.slice\(0, 16\)/.test(reader.text)) {
    throw new Error('Storage namespace suffix algorithm changed; migrate V1 data deliberately')
  }
  return {
    format: 1,
    package: { name: packageJson.name, exports: packageJson.exports, dsh: packageJson.dsh },
    patch,
    plugins: { readerHost: plugin(reader), nativeHost: plugin(native), ocrHost: plugin(ocr), imageHost: plugin(image), readerClient: plugin(client) },
    providedServices: [...new Set([
      literal(exportedConstant(native, 'provide')), literal(exportedConstant(ocr, 'provide')),
      literal(exportedConstant(image, 'provide')), ...reflectedServices,
    ])].sort(),
    rpcMethods: [...new Set(endpoints)].sort(),
    toolNames: [...new Set(toolNames)].sort(),
    storage: {
      suffix: 'sha256(namespace).slice(0,16)',
      // Freeze the three authoritative V1 domains. New, disposable derived
      // data domains must not rewrite this published storage contract.
      domains: calls(reader, 'defineDomain').map(call => storageDomain(call, reader))
        .filter(domain => ['pdf_drafts_${suffix}', 'pdf_bookmarks_${suffix}', 'pdf_positions_${suffix}'].includes(domain.name)),
      keyExpressions: verifyV1KeyAlgorithms(drafts, navigation),
    },
    clientExtensions: {
      slots: clientSlots.sort(),
      previewExtensions: stringArray(property(preview.arguments[0], 'extensions')),
      binaryExtensions: stringArray(property(preview.arguments[0], 'binaryExtensions')),
    },
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(await collectCompatibilityManifest(), null, 2)}\n`)
}

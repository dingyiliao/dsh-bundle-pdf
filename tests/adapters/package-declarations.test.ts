import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = new URL('../../', import.meta.url)
const execute = promisify(execFile)

async function declarations(directory: string): Promise<string[]> {
  const entries = await readdir(new URL(directory, root), { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) result.push(...await declarations(path))
    else if (entry.name.endsWith('.d.ts')) result.push(path)
  }
  return result
}

test('published declaration graph contains no stale TypeScript import extensions', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
    exports: Record<string, string | { types?: string }>
  }
  for (const target of Object.values(manifest.exports)) {
    if (typeof target === 'object' && target.types) {
      const entry = new URL(target.types, root)
      assert.match(await readFile(entry, 'utf8'), /export|declare/)
    }
  }
  const paths = await declarations('dist/types')
  assert.ok(paths.length > 0, 'declaration build must produce public SDK types')
  for (const path of paths) {
    const source = await readFile(new URL(path, root), 'utf8')
    assert.doesNotMatch(source, /\b(?:from|import)\s*\(?\s*['"][^'"]+\.tsx?['"]/, `${join(path)} has a source-only import`)
  }
  assert.equal(paths.some(path => path.startsWith('dist/types/client/native/')), false,
    'removed Client native shims must not survive in the package')
})

test('published engine SDKs type-check independently in third-party packages', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-engine-sdk-consumer-'))
  try {
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { name: string }
    const packageRoot = join(fixture, 'node_modules', manifest.name)
    await mkdir(packageRoot, { recursive: true })
    // Reproduce the shipped declaration graph without src/ or repository tsconfig paths.
    await copyFile(new URL('package.json', root), join(packageRoot, 'package.json'))
    await cp(new URL('dist/types', root), join(packageRoot, 'dist/types'), { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(fileURLToPath(new URL('node_modules', root)), join(packageRoot, 'node_modules'), linkType)
    await symlink(fileURLToPath(new URL('node_modules/@deepseek-ai', root)),
      join(fixture, 'node_modules/@deepseek-ai'), linkType)

    const consumers = [
      ['ocr-host', 'HostOcrBackend', 'ocr'],
      ['image-host', 'ImageUnderstandingBackend', 'imageUnderstanding'],
      ['translation', 'TranslationEngine', 'pdfTranslation'],
      ['embedding', 'EmbeddingEngine', 'pdfEmbedding'],
    ] as const
    for (const [subpath, engineType, service] of consumers) {
      await t.test(`${manifest.name}/${subpath}`, async () => {
        const consumer = join(fixture, `consumer-${subpath}`)
        await mkdir(consumer)
        await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: `example-${subpath}-engine`, type: 'module' }))
        await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
            strict: true, noEmit: true, skipLibCheck: true, types: [],
          },
          include: ['index.ts'],
        }))
        await writeFile(join(consumer, 'index.ts'), [
          "import type { Context } from '@deepseek-ai/cordis'",
          `import type { ${engineType} } from '${manifest.name}/${subpath}'`,
          `export const inject = ['${service}']`,
          `declare const engine: ${engineType}`,
          `export function apply(ctx: Context) { ctx.effect(() => ctx.${service}.register(engine)) }`,
        ].join('\n'))
        // Each compiler invocation loads one SDK only, so another SDK cannot mask missing augmentation.
        await execute(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)),
          '--project', join(consumer, 'tsconfig.json')], {
          cwd: consumer, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
        }).catch((error: Error & { stdout?: string; stderr?: string }) => {
          assert.fail(`${subpath} SDK failed external compilation:\n${error.stdout ?? ''}${error.stderr ?? ''}\n${error.message}`)
        })
      })
    }
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

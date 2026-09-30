import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ownerRoot = dirname(fileURLToPath(import.meta.url))
const dshRoot = resolve(ownerRoot, '..', 'deepseek-harness')
const dshConfigPath = join(dshRoot, 'vitest.web.config.ts')

if (!existsSync(dshConfigPath)) {
  throw new Error(`PDF Web e2e needs the adjacent DSH checkout at ${dshRoot}; clone deepseek-harness beside this plugin`)
}

const { default: dshConfig } = await import(pathToFileURL(dshConfigPath).href)

export default {
  ...dshConfig,
  root: dshRoot,
  test: {
    ...dshConfig.test,
    include: [join(ownerRoot, 'tests', 'web.e2e.ts').replaceAll('\\', '/')],
    fileParallelism: false,
  },
}

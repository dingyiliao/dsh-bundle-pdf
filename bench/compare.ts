import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { readRows, compareMarkdown } from './report.ts'

const { values } = parseArgs({ options: { before: { type: 'string' }, after: { type: 'string' },
  out: { type: 'string', default: 'comparison.md' }, 'allow-identical': { type: 'boolean', default: false } } })
if (!values.before || !values.after) throw new Error('Usage: npm run bench:compare -- --before FILE.jsonl --after FILE.jsonl --out REPORT.md')
const before = await readRows(values.before), after = await readRows(values.after)
if (!values['allow-identical'] && before[0].source.treeSha256 === after[0].source.treeSha256) throw new Error('Identical source trees; no before/after upgrade. Use --allow-identical only for a deliberate control run.')
await writeFile(values.out!, compareMarkdown(before, after))
console.log(values.out)

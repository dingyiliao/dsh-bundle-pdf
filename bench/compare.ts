import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { readRows, compareMarkdown } from './report.ts'

const { values } = parseArgs({ options: { before: { type: 'string' }, after: { type: 'string' },
  out: { type: 'string', default: 'comparison.md' }, 'allow-identical': { type: 'boolean', default: false }, 'allow-backend-switch': { type: 'boolean', default: false } } })
if (!values.before || !values.after) throw new Error('Usage: npm run bench:compare -- --before FILE.jsonl --after FILE.jsonl --out REPORT.md')
const before = await readRows(values.before), after = await readRows(values.after)
if (!values['allow-identical'] && !values['allow-backend-switch'] && before[0].source.treeSha256 === after[0].source.treeSha256) throw new Error('Identical source trees; no before/after upgrade. Use --allow-backend-switch for a recorded engine A/B test.')
await writeFile(values.out!, compareMarkdown(before, after, { allowBackendSwitch: values['allow-backend-switch'] }))
console.log(values.out)

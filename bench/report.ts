import { readFile } from 'node:fs/promises'
import { rowSchema, type BenchmarkRow } from './schema.ts'

export function quantile(values: readonly number[], probability: number): number | null {
  if (!(probability >= 0 && probability <= 1)) throw new Error('Invalid quantile probability')
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)]
}

export async function readRows(path: string): Promise<BenchmarkRow[]> {
  const lines = (await readFile(path, 'utf8')).split('\n').filter(x => x.trim())
  if (!lines.length) throw new Error('No benchmark rows')
  const rows = lines.map(line => rowSchema.parse(JSON.parse(line)))
  if (new Set(rows.map(row => row.runId)).size !== rows.length) throw new Error('Duplicate runId')
  if (new Set(rows.map(row => row.expectedRowCount)).size !== 1 || rows[0].expectedRowCount !== rows.length) throw new Error('Incomplete result inventory')
  if (new Set(rows.map(row => row.repeatCount)).size !== 1) throw new Error('Mixed repeat counts')
  for (const values of groups(rows).values()) {
    const iterations = new Set(values.map(row => row.iteration))
    if (values.length !== rows[0].repeatCount || iterations.size !== values.length
      || values.some(row => row.iteration >= row.repeatCount)) throw new Error('Incomplete or duplicate group iteration inventory')
  }
  return rows
}

export function groupKey(row: BenchmarkRow) {
  return JSON.stringify([row.measurementKind, row.scenario, row.documentId, row.documentSha256, row.cacheState, row.qualityMode, row.seed])
}

export function groups(rows: readonly BenchmarkRow[]) {
  const grouped = new Map<string, BenchmarkRow[]>()
  for (const row of rows) { const key = groupKey(row); const values = grouped.get(key) ?? []; values.push(row); grouped.set(key, values) }
  return grouped
}

const display = (value: number | null) => value === null ? 'unavailable' : value.toFixed(3)
const escape = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ')
const lowerIsBetter = new Set(['durationMs', 'cpuMs', 'hostMaxRssMiB', 'heapUsedMiB', 'hostEventLoopP99Ms',
  'firstUsefulProxyMs', 'targetQualityProxyMs', 'scrollSettleProxyMs', 'rafIntervalP95Ms', 'rafIntervalMaxMs',
  'blankAreaTimeRatio', 'maxBlankAreaRatio', 'canvasPixelBytesEstimate', 'longTaskTotalMs', 'longTaskMaxMs'])
function uniformProvenance(rows: readonly BenchmarkRow[]) {
  if (!rows.length) throw new Error('No benchmark rows')
  if (new Set(rows.map(row => JSON.stringify(row.source))).size !== 1) throw new Error('Mixed source versions within one result')
}
export function summaryMarkdown(rows: readonly BenchmarkRow[]) {
  uniformProvenance(rows)
  const lines = [
    '# PDF M0 基准结果', '',
    '这是组件基线，不是完整 DSH、PDFium 或 Acrobat 的前后性能证明。合成语料不代表全部真实 PDF。', '',
    '时间单位见指标名：Ms 为毫秒，MiB 为内存；Bytes 为字节；Ratio 为比例；Count 为数量。样本不足时 p95 仅为描述值，不作可靠尾延迟承诺。', '',
    '| 场景 | 文档 | 指标 | 成功/全部 | p50 | p95（描述） |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const values of groups(rows).values()) {
    const first = values[0], valid = values.filter(row => row.status === 'ok' && row.qualityPassed)
    const names = [...new Set(values.flatMap(row => Object.keys(row.metrics)))].sort()
    if (!names.length) lines.push(`| ${escape(first.scenario)} | ${escape(first.documentId)} | no samples | ${valid.length}/${values.length} | unavailable | unavailable |`)
    for (const name of names) {
      const numbers = valid.map(row => row.metrics[name]).filter((value): value is number => typeof value === 'number')
      lines.push(`| ${escape(first.scenario)} | ${escape(first.documentId)} | ${escape(name)} | ${numbers.length}/${values.length} | ${display(quantile(numbers, 0.5))} | ${display(quantile(numbers, 0.95))} |`)
    }
  }
  lines.push('', '## 测量边界', '',
    '- Host 组件计时不含输入文件读取及预先准备；hostMaxRssMiB 是该单次子进程全生命周期峰值，包含启动、准备和正确性验证。',
    '- 浏览器组件直接使用仓库的 Reader、Page、PDF.js runtime 和 Host workspaces；文件/草稿适配器为测试内存实现，未经过 DSH 授权或真实持久写盘。',
    '- firstUsefulProxyMs/targetQualityProxyMs 以完成 raster 的 DOM、实际有效采样比例、覆盖面积和下一帧为代理；它们不是硬件呈现时刻。',
    '- 滚动 rAF 间隔是主线程回调代理；本工具不把它报告成真实呈现帧、丢帧率或 FPS。',
    '- canvasPixelBytesEstimate 为活跃画布估计，不能代替浏览器/GPU/native 总内存。',
    '- event loop 的短样本统计仅供诊断；不足样本或未支持的指标为 null，不能当作零。', '',
    '## 运行环境与版本', '', '```json', JSON.stringify({ environment: rows[0]?.environment, source: rows[0]?.source }, null, 2), '```', '',
    '## 失败记录', '')
  const failed = rows.filter(row => row.status !== 'ok' || !row.qualityPassed)
  lines.push(...(failed.length ? failed.map(row => `- ${escape(row.runId)}: ${escape(row.error ?? 'quality check failed')}`) : ['- 无。']))
  return `${lines.join('\n')}\n`
}

export function compareMarkdown(before: readonly BenchmarkRow[], after: readonly BenchmarkRow[], options: { allowBackendSwitch?: boolean } = {}) {
  uniformProvenance(before); uniformProvenance(after)
  const left = groups(before), right = groups(after)
  if (left.size !== right.size || [...left.keys()].some(key => !right.has(key))) throw new Error('Scenario/corpus/cache/quality/seed groups do not match')
  const lines = ['# PDF 组件基准对比', '',
    '仅比较相同测量边界和环境。已定义“越小越好”的指标按旧 p50 与新 p50 计算降幅；计数和文件大小不自动解释为改进。smoke 样本不产生置信区间或发布级加速结论。', '',
    '| 场景 | 文档 | 指标 | 旧样本成功/全部 | 新样本成功/全部 | 旧 p50 | 新 p50 | 降幅 | 旧 p95 | 新 p95 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const [key, a] of left) {
    const b = right.get(key)!
    if (options.allowBackendSwitch && new Set([...a, ...b].map(row => row.environment.readerEngine)).size !== 2) throw new Error('Backend comparison requires two different recorded reader engines')
    const environments = [...a, ...b].map(row => JSON.stringify(Object.entries(row.environment)
      .filter(([key]) => !options.allowBackendSwitch || !['readerEngine', 'pdfiumBuild'].includes(key)).sort(([x], [y]) => x.localeCompare(y))))
    if (new Set(environments).size !== 1) throw new Error('Environment differs; same-device comparison required')
    if (new Set([...a, ...b].map(row => row.source.benchmarkVersion)).size !== 1) throw new Error('Benchmark definitions differ')
    if (new Set([...a, ...b].map(row => row.source.protocolSha256)).size !== 1) throw new Error('Benchmark protocol source differs; rebaseline with one frozen harness')
    if (new Set([...a, ...b].map(row => row.suite)).size !== 1) throw new Error('Benchmark suites differ')
    if (new Set(a.map(row => row.iteration)).size !== a.length || new Set(b.map(row => row.iteration)).size !== b.length) throw new Error('Duplicate iteration')
    if (a.length !== b.length || a.some(row => !b.some(other => other.iteration === row.iteration))) throw new Error('Paired iteration inventory differs')
    const validA = a.filter(row => row.status === 'ok' && row.qualityPassed)
    const validB = b.filter(row => row.status === 'ok' && row.qualityPassed)
    const names = [...new Set([...a, ...b].flatMap(row => Object.keys(row.metrics)))].sort()
    for (const name of names) {
      const av = validA.map(row => row.metrics[name]).filter((x): x is number => typeof x === 'number')
      const bv = validB.map(row => row.metrics[name]).filter((x): x is number => typeof x === 'number')
      const am = quantile(av, 0.5), bm = quantile(bv, 0.5)
      const reduction = lowerIsBetter.has(name) && av.length === a.length && bv.length === b.length
        && am !== null && bm !== null && am > 0 && validA.length === a.length && validB.length === b.length
        ? `${((am - bm) / am * 100).toFixed(1)}%` : 'unavailable'
      lines.push(`| ${escape(a[0].scenario)} | ${escape(a[0].documentId)} | ${escape(name)} | ${av.length}/${a.length} | ${bv.length}/${b.length} | ${display(am)} | ${display(bm)} | ${reduction} | ${display(quantile(av, 0.95))} | ${display(quantile(bv, 0.95))} |`)
    }
  }
  if (options.allowBackendSwitch) lines.splice(2, 0, `本报告比较同一实现中的引擎配置：${String(before[0].environment.readerEngine)} → ${String(after[0].environment.readerEngine)}。该比较不能单独代表相对于历史版本的全部升级收益。`, '')
  return `${lines.join('\n')}\n`
}

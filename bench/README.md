# PDF M0：可重跑的组件基线

本目录实现升级计划的 **M0 初始测量层**。直接调用现有 Host 解析/投影/保存物化，并在 Chromium 中运行仓库现有的 Reader、Page、PDF.js Worker。尚未接入 PDFium，没有执行完整 DSH 桌面 E2E 或与 Acrobat 的对比。数据可用于后续相同协议的组件回归，不能单独证明整个新设计已实现提速。

## 运行

要求 Node 22+；依赖版本由 `package-lock.json` 固定。首次安装：

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run check
npm run bench:corpus
npm run bench -- --suite smoke --out bench-results/host-baseline
npm run bench:browser -- --suite smoke --out bench-results/reader-baseline
```

`--ignore-scripts` 跳过安装时的自动构建，`npm run check` 会执行正式构建和检查。若已有隔离的 Playwright 缓存，用 `PLAYWRIGHT_BROWSERS_PATH=/absolute/cache/path` 指定。运行浏览器基准需要 Chromium 的系统依赖以及本地 loopback 监听权限。

测试依赖固定为 Playwright 1.58.2 / Chromium 145；使用 `channel: chromium` 的新 headless 模式。初始实跑发现原锁文件的 Chromium 131 缺少 `Uint8Array.toHex`，Chromium 141 又缺少 `Map.getOrInsertComputed`，均不能完成当前 PDF.js modern build 的页面渲染。工具现在在计时前检查这些能力并记录失败。该结果是兼容性发现；没有向测试页面注入 polyfill 来隐藏它。目标 DSH/Electron 与 macOS Safari/WebKit 仍须独立验收，不能把 esbuild target 当作运行时 API 支持保证。

两个 runner 的 `--repeats` 默认 smoke=3、release=20；`--timeout` 单位毫秒，默认 60000。输出路径中的 `runs.jsonl` 必须不存在，避免覆盖基线。浏览器可用 `--document paper-12 --scenario reader.open` 先排查单场景。基准输出和生成 PDF 都被 Git 忽略。

```sh
npm run bench -- --suite release --repeats 20 --out bench-results/host-candidate
npm run bench:browser -- --suite release --repeats 20 --out bench-results/reader-candidate
npm run bench:compare -- --before bench-results/host-baseline/runs.jsonl --after bench-results/host-candidate/runs.jsonl --out bench-results/host-comparison.md
```

前后必须采用同一个 suite、次数、语料、环境和协议；上面 smoke 与 release 的示例代表不同运行模式，不能混合比较。**release 参数只扩大重复次数，不等同于发布验收通过**；仍需完成计划中的真实 PDF、平台矩阵、端到端持久化与独立画质验收。相同源树默认拒绝比较；`--allow-identical` 仅用于验证报告工具。

## 固定语料

生成器使用固定日期、稳定 ID 和 seed=187。`manifest.json` 记录 SHA-256、页数、标注数、许可证和特性；每次执行前验证原始 PDF 的 SHA-256。重新生成到另一个目录，可验证确定性。

| ID | 页数 | 标注 | 目的 |
| --- | ---: | ---: | --- |
| paper-12 | 12 | 0 | 普通文档首屏、缩放、滚动 |
| text-1000 | 1000 | 0 | 长文档元数据成本、页面占位 DOM |
| annotations-1000 | 12 | 1000 | 原生 Text 便笺与元数据压力 |

这些文件仅包含拉丁文字、混合页尺寸和 Text 便笺，不涵盖 CJK、扫描图、复杂矢量、表单、签名、加密、CropBox 偏移、旋转或损坏 PDF。原仓库功能测试继续覆盖其中若干正确性场景；发布性能语料须另外补齐。

## 场景与计时口径

| 场景 | 计时范围 | 正确性验证 |
| --- | --- | --- |
| host.inspect | 输入字节准备完成 → `loadPdfDocument` 返回 | 页数/标注数匹配 manifest |
| host.project | 已解析基线 → 投影一次新增标注 | 标注计数增加 1 |
| host.history-replay | 已解析基线 → 重放 100 个新增操作 | 标注计数增加 100 |
| host.materialize | 原始字节 → 新增一次操作的 PDF/元数据返回 | 独立重新打开并检查页数和新增 ID |
| reader.open | 挂载 Reader → 可见页面 raster 完成与采样质量达标 | 可见画布含墨迹、文本层存在、页占位数匹配 |
| reader.scroll | 从 100% 顶部开始，1500ms 内沿时间移动最多 8000 CSS px | 到达指定终点，停止后 raster/文本恢复 |
| reader.zoom4x | 从已渲染 100% 页面发送两次 Ctrl+wheel → 提交 400% 与新 raster | 完成目标比例、实际像素密度满足现有安全上限 |

Host 每次使用新 Node 子进程；输入读取/预解析不计入操作计时。Browser 共用一个浏览器进程，每次使用全新 context 和 Host workspace；应用脚本下载、浏览器启动和滚动/缩放的初始打开不计入对应场景。OS 文件缓存和机器热状态未清空；这些结果不叫“冷机启动”。文件和 draft 为内存适配器，RPC 走真实 loopback HTTP，但没有 DSH 授权链或真实 fsync。

## 指标

| 指标 | 定义与限制 |
| --- | --- |
| durationMs / cpuMs | Host 操作壁钟/当前子进程 CPU 时间 |
| hostMaxRssMiB | 子进程全生命周期峰值 RSS，含启动、准备和正确性复核 |
| heapUsedMiB | 验证后的堆快照；不是操作内存峰值 |
| hostEventLoopP99Ms | 10ms 采样的诊断值；少于 100 个样本记 null，不能解释为无阻塞 |
| firstUsefulProxyMs | 可见 PDF 面积至少 90% 已有完成的 bitmap；缩放时允许保留旧低清 bitmap |
| targetQualityProxyMs | 可见面积至少 99% 有完成的 raster，实际采样密度满足 DPR≤2 和 2400 万像素的现有上限，再经过下一帧检查 |
| blankAreaTimeRatio | 滚动 rAF 样本中未完成 bitmap 的可见 PDF 面积比例，按时间间隔加权；排除页外背景 |
| rafIntervalP95Ms / rafIntervalMaxMs | 滚动过程主线程 rAF 回调间隔，**不是呈现 FPS/丢帧率** |
| scrollSettleProxyMs | 最后一次滚动位置更新 → 最终视口达到目标 raster 质量 |
| canvasPixelBytesEstimate | 附着在 DOM 的 canvas 宽×高×4；滚动取采样峰值。遗漏尚未附着的渲染、GPU、副本等 |
| longTaskTotalMs / longTaskMaxMs | 支持 Long Tasks API 时，计时范围内开始的主线程长任务统计 |
| browserTotalRssMiB | 当前未采集，始终 null；不得拿画布估计替代整个浏览器/Host/native 的内存 |

首屏与清晰时间都是 **DOM/raster + rAF 代理**，不是操作系统或 GPU 的硬件呈现时刻。墨迹和文本检查可防空白页，但不是独立参考引擎的像素/字体/标注一致性测试。性能事件的 Host/Client `startMs` 属于不同单调时钟，只能在各自域内分析。

## 输出与可比性

- `runs.jsonl`：全部成功、失败、超时记录；schema、预期记录/重复数量、环境、源码 commit/dirty/tree SHA-256、基准协议源码 SHA-256、语料 SHA、单调时钟阶段和指标。运行结束原子替换完整 JSONL，并校验记录数与逐组 iteration；中途的增量日志只作崩溃证据，不算完整基线。
- `summary.md`：每组 p50、nearest-rank p95、成功/全部样本数、测量边界和失败列表。3 次的 p95 实际是最大值，仅供 smoke 描述。
- 浏览器首轮每个场景保存 PNG 供人工复核；截图在计时完成后生成。
- 对比工具拒绝不同语料/缓存/清晰度/seed/环境/suite/基准协议源码、重复或不配对 iteration，以及同一结果内部混合源码。任一失败/质量不通过/缺测会阻止对应“降幅”输出；计数、文件字节数不会自动包装成性能改善。
- 工具当前没有配对 bootstrap 置信区间、随机 AB/BA 版本调度或独立真实用户会话重复。这些需在计划的正式发布基准层实现。

## 埋点

`src/shared/performance.ts` 提供显式 observer。没有订阅时不生成事件；插件不会自动上传数据。仅记录数值/布尔属性，不记录 PDF 正文、文件路径、文档 ID、凭据。collector 由调用者管理，退订后不接收迟到完成；observer 抛错不会改变 PDF 操作结果。测试 adapter/global hook 不进入正式构建。

已覆盖 Host inspect、project、materialize、dispatch，以及 Client RPC、worker-open、raster、search。Host dispatch 包含同 session 队列等待；阶段耗时可能嵌套，不能相加作为端到端耗时。正式质量/内存/取消测试仍按升级计划追加。

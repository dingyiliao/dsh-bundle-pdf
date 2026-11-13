# PDF 插件性能证据

这里汇总已冻结的组件基准及其适用边界。运行命令、语料、计时范围和指标定义统一放在 [bench/README.md](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/bench/README.md)；下表不能代表完整 DSH Desktop、真实用户文档或发布版本的性能。

## 索引与重启恢复

[2026-11-02 索引基准](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/docs/benchmarks/indexing-20261102/README.md)在相同合成语料、真实临时 SQLite 目录、固定 1024 维假向量下各运行 3 次。表中为中位数；[改前](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/docs/benchmarks/indexing-20261102/before.json)、[改后](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/docs/benchmarks/indexing-20261102/after.json)及[源码／环境标识](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/docs/benchmarks/indexing-20261102/provenance.json)均已归档。

| 页 × 每页段落 | 冷建：改前 → 改后 | 文档向量请求：改前 → 改后 | 重启恢复：改前 → 改后 |
| --- | ---: | ---: | ---: |
| 32 × 1 | 1160.1 → 22.9 ms | 32 → 3 | 13.4 → 2.6 ms |
| 16 × 8 | 1568.4 → 43.7 ms | 16 → 8 | 24.4 → 4.9 ms |
| 1 × 128 | 1266.2 → 59.6 ms | 8 → 8 | 25.1 → 4.5 ms |

冷建的**本地索引开销**下降约 95–98%；重启恢复没有额外页面提取或文档向量请求。模型没有延迟，基准不调用 PDFium、OCR、网络或真实 embedding 服务，且未清空 OS 文件缓存；不能将降幅套用到真实 OCR／视觉索引或整机 CPU/RSS。

## 阅读器交互

[2026-10-16 交互基准](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/docs/benchmarks/interaction-opt-20261016/README.md)固定 macOS arm64、Chrome 155、三份合成语料与同一协议。Reader 改前／改后均为 55/55 成功，每场景 5 次。以下是 p50；此样本量的 p95 实际接近最大观测值，不宜作尾延迟结论。[原始数据与完整对照](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/docs/benchmarks/interaction-opt-20261016/reader-comparison.md)包含其他场景、画布成本及失败哨兵。

| Reader 场景 | 改前 → 改后 p50 |
| --- | ---: |
| 12 页首屏达到目标画质 | 159.1 → 136.2 ms |
| 1000 批注首屏达到目标画质 | 454.4 → 305.4 ms |
| 1000 页首次无命中搜索 | 4183.4 → 2499.9 ms |
| 1000 页同词重复搜索 | 2100.0 → 33.3 ms |

千批注首屏 DOM 元素约 11,069 → 4,053。采用 768px tile 后，普通文档滚动时已附着 canvas 像素字节估计增加约 19.5%；千页滚动恢复清晰的 p50 从 32.6 变为 33.2 ms，不能只报告改善项。画布估计不是浏览器、Host、原生 helper 或 GPU 的峰值内存。该基准的 Host 改后为 60/60 成功，但没有可配对的 Host 改前数据，不计算 Host 降幅。

## 原生组件基线

[2026-10-14 原生组件基准](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/docs/benchmarks/native-v1-20261014/README.md)在 Apple M5 Pro、macOS arm64、Node 26.7.0、Chrome 155 上按 `release` 每场景运行 20 次；源码树标记为 dirty，不能当作干净发布构建。代表性 p50：千页 Host 打开检查 65.1 ms、保存物化 64.7 ms，千页 Reader 首屏目标画质 185.2 ms。首次 Host 运行有一条 60 秒超时，使用 120 秒上限复跑后为 240/240 成功；超时原因未查明，不据此宣称已修复。[2026-09-30 旧版对照](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/docs/benchmarks/native-v1-20260930/README.md)是独立冻结记录，不能和不同协议的数据直接计算当前加速比例。

## 解释边界

- Host 组件不包含完整 DSH 授权、桌面启动、真实文件持久写盘与浏览器渲染；Reader 组件不包含完整桌面链路。`release` 仅表示重复次数，不等于发布验收。
- Reader 首屏／清晰时间是 DOM、raster 与下一帧检查的代理，不是屏幕真实呈现时刻。滚动的 rAF 间隔不是 FPS；`canvasPixelBytesEstimate` 也不是进程 RSS。
- 合成语料没有代表扫描件、复杂字体、加密文件、真实千页文档和各种批注外观。检索的[索引基准](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/docs/benchmarks/indexing-20261102/README.md)同样不评价搜索质量。
- 完整 Desktop 在真实 PDF 上的交互耗时、前后配对 CPU/RSS、OCR／视觉模型延迟及画质仍缺少同协议测量；不能从这些组件结果推出整机性能或 SLA。

# P0 性能基线

> **历史基线**：以下数字是 P0 阶段的一次性快照，不是当前架构或当前测试结果。当前架构为 374 个源文件、41,724 行；测试结果和 Phase 1/2 证据见 [refactor-plan-v2.md](./refactor-plan-v2.md) 与 [performance.md](../performance.md)。

状态：P0 已完成（历史快照）。Native 冒烟和合成索引基线已完成；Desktop 实机交互测量仍待在匹配版本的 DSH 中执行。

## 当前基线证据

- 架构扫描：366 个 TypeScript 文件、41,246 行；Host→Client 和 Client→Host 直接导入均为 0。
- 类型检查：`npm run typecheck`、`npm run typecheck:tests` 通过。
- 完整 Node 测试：2641 个测试，2640 通过、1 个跳过、0 个失败，耗时约 153 秒（运行时长随本机缓存和负载波动）。
- JSON 协议 schema 和 golden fixtures：已通过 JSON 解析检查。
- Native 真实扩展路径：在 `DSH_PDF_REQUIRE_NATIVE_EXTENSIONS=1` 下运行 `tests/native-document-port.test.ts`、`tests/native-integration.test.ts`、`tests/native-provider.test.ts`，30 个测试全部通过，约 410ms。
- P1 transport 切片后的架构扫描：367 个 TypeScript 文件、41,280 行；Host→Client 和 Client→Host 直接导入仍为 0。
- 合成索引基线：`npm run bench:indexing -- /tmp/dsh-plugin-pdf-p0-indexing.json` 已完成。该基准使用真实文件系统和 SQLite 持久化，但不包含 PDFium、OCR、模型推理、网络或用户 PDF；只用于比较缓存/恢复路径。

### 合成索引结果（Apple M5 Pro，Node v26.7.0，arm64）

| 场景 | 冷启动平均 | 暖缓存平均 | 重启恢复平均 | 冷启动 CPU | 恢复 CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| 32 页 × 1 段 | 28.416ms | 0.096ms | 3.537ms | 39.719ms | 4.670ms |
| 16 页 × 8 段 | 47.741ms | 0.084ms | 5.453ms | 55.792ms | 6.544ms |
| 1 页 × 128 段 | 63.913ms | 0.080ms | 4.694ms | 76.785ms | 4.946ms |

结果说明：恢复路径没有额外页面读取、文档批处理或磁盘写入；这些数字不能外推到真实 PDF/OCR/embedding 耗时，也不能作为优化完成的证明。

以上是重构前的软件基线，不等于已经完成滚动、跳转、拖选、缩放和索引的实机性能基线。

## 固定环境

- 机器：记录芯片、内存、系统版本和 DSH 版本；
- 插件：记录插件版本、Native build manifest、PDFium revision 和 patchset hash；
- 语料：至少一份普通文字 PDF、一份大文档、一份扫描 PDF、一份含图片/公式文档；
- 缓存：冷启动 3 次，暖缓存 5 次；
- 操作：滚动、拖选、缩放、页跳转、书签跳转、关键词搜索、语义搜索和后台索引。

## 指标

| 指标 | 目标 |
| --- | --- |
| 普通文档交互 p95 帧时间 | ≤16.7ms |
| 大文档交互 p95 帧时间 | ≤33.3ms |
| 后台索引期间前台 p95 回归 | 相对基线 ≤10% |
| CPU 峰值、峰值内存、IPC 次数 | 相对基线 ≤15% |
| 重复渲染次数 | 不得因后台任务持续增长 |
| 索引失败续跑 | 已完成页不重复 OCR/向量 |

## 采样要求

每个场景记录 p50、p95、最大值、CPU、峰值内存、IPC 次数、长任务数量和重复渲染次数。报告必须同时保留原始日志和汇总结果，不能只写“感觉流畅”。

## 运行入口

P0 复用现有 `npm run arch:report`、`npm run bench:indexing`、`npm run bench:browser` 和 Desktop 实机测量；如果需要新增脚本，先记录测量协议，再实现脚本。

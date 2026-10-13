# PDF 0.1.0 原生组件基准（2026-10-14）

这组数据测量 Host 与 Reader 组件，不是完整 DSH Desktop 的端到端性能，也不能与 [2026-09-30 的旧协议结果](../native-v1-20260930/README.md)计算加速比例。指标解释和结果摘要见 [PERFORMANCE.md](../../../PERFORMANCE.md)。

- 功能代码提交：`0edd1f11bf3b7c37b3601a5b2474c027bfab8d92`；基准协议：`m0-v1`，SHA-256 `c7fc11f35ebc203e52cfe064b5d832e34e38ffd64dcf4de67558d4c18f0c98b4`。
- Host 与 Reader 的源码树 SHA-256 同为 `ced731fad8885755825c304b2bc228d2698628fa086d838f8ff590ba3ba04050`。本机有未提交改动，结果标记 `dirty: true`；它们不是干净发布构建的基线。
- 环境：macOS arm64、Apple M5 Pro、Node 26.7.0；Reader 使用自定义无头 Chrome 155.0.8059.40、1200×900 视口、DPR 2；PDFium 156.0.8076.0。
- 两个 runner 都用 `--suite release`，每个场景重复 20 次。首次 Host 运行使用默认 60000 ms 超时：240 条中 1 条 `host.inspect/text-1000` 超时；完整复跑时将超时上限改为 120000 ms，得到 240/240 通过。Reader 为 180/180 通过。单次超时的原因未查明。
- 归档保留全部运行记录；仅将首次 Host 超时记录的 `error` 字段中的本机绝对可执行文件和仓库路径改为相对占位写法，状态、环境、指标和其他字段未改动。

原始记录：

- [首次 Host 运行](./host-release-first.jsonl)
- [Host 完整复跑](./host-release-retry.jsonl)
- [Reader 运行](./reader-release.jsonl)

仓库的 [基准说明](../../../bench/README.md)列出语料、场景、计时边界和复跑方法。`release` 仅表示重复次数，不等于发布验收通过。

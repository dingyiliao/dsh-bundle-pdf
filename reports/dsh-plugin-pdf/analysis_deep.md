# DSH PDF 插件发布就绪审计

> 历史审计快照：本文记录 2026-11-15 重构及发布完善前后的检查过程，不是当前发布状态的权威来源；当前结果以 CI、`CHANGELOG.md` 和发布文档为准。

- **来源**: `/Users/dylan/Workspace/AI/dsh-plugin-pdf/.agents/worktrees/working-copy-model`
- **项目类型**: framework（DSH 插件／公共引擎 SDK）+ application/native engine
- **分析深度**: deep
- **写作风格**: concise
- **生成日期**: 2026-11-15
- **commit**: `f97bd90`

## 结论

**当前不具备直接发布条件。** 主体架构、Node 测试、类型、构建、原生 helper 和单平台打包已达到较高成熟度，但发布门禁尚缺少当前工作树的完整 100% 项目覆盖率/Web 证据；新增“可能签名”交互没有端到端测试；工作树有 60 项未提交变更；包安装 smoke 在当前 worktree 环境无法完成 SDK consumer 编译。

| 级别 | 状态 | 发布影响 |
| --- | --- | --- |
| P0 | 当前工作树未取得 `test:coverage:project` 成功结果 | 不能声明 100% 项目行覆盖率，违反既有发布门禁 |
| P0 | 当前工作树未跑通 Web E2E/coverage lane | Client 保存确认与 Reader 签名提示未获得真实浏览器贯穿验证 |
| P0 | 60 项未提交变更，含 4 个新增文件 | 不存在可复现、可由 CI 验证的发布 commit |
| P1 | `signatureUncertain` 只有 metadata/status 单测，没有 Reader 保存流程和模型保存风险测试 | 新产品语义的关键交互覆盖不足 |
| P1 | package smoke 的清洁安装/native hello 通过，但公共 SDK consumer 编译失败 | 本地 worktree 缺依赖导致；正式 CI 应阻断发布直到同一归档完整通过 |
| P2 | 代码/测试规模较大，`working-copy/service.ts` 仍集中承担驻留、所有权、密码、冲突、发布和调度 | 可维护性风险，不是本次发布硬阻塞，但“足够精简”不能下绝对结论 |

## 问题域

项目把 PDF Reader、模型工具、共享工作副本、PDFium 写入、OCR/检索及插件 SDK 集成到 DSH。没有该插件，用户需分别使用阅读器、OCR/翻译工具和聊天模型，并自行维持页码、引用、草稿、签名风险及保存冲突。

## 概念与术语

**WorkingCopyRecord / OperationSet** *(项目抽象)*
逻辑工作副本与操作历史；即使 native baseline 被淘汰，操作仍可存在。
→ `src/modules/working-copy/model.ts:36-50`。

**BaselineResource / BaselineProvider** *(项目抽象)*
精确 PDF 字节、来源身份和解析文档的固定基线；获取边界封装密码和 native 细节。
→ `src/modules/working-copy/model.ts:19-29,83-92`。

**ContentContext** *(项目抽象)*
Reader/model renderer 共用的 baseline/revision/content fence，不携带 native 句柄。
→ `src/modules/working-copy/model.ts:52-68`。

**signatureUncertain** *(项目抽象)*
native 无法证明不存在签名；允许编辑，但保存按潜在签名失效风险提示。
→ `src/core/pdf-types.ts:97-101`、`src/adapters/host/pdfium/document-metadata.ts:87-106`。

## 设计与实现审计

### 工作副本模型

- 四层模型已有显式类型；`BaselineProvider.acquire/release` 是统一获取接口（`src/modules/working-copy/model.ts:23-29,36-50,52-68,83-92`）。
- service 使用 provider 分类受保护、容量、native 不可用等失败（`src/modules/working-copy/service.ts:170-231`）。
- 源变化不会自动清操作，而是建立 mismatch decision（`docs/architecture.md:74-91`；`src/modules/working-copy/service.ts` 的 refresh/open 分支）。
- service 文件仍约千行，且同时拥有引用计数、驻留、密码、基线获取、草稿恢复、冲突、命令调度；本次重构增加了模型清晰度，但实现编排仍偏集中（代表点：`src/modules/working-copy/service.ts:29-105,141-231,640-689`）。

### 签名语义

- 已知或可能签名不再作为普通 PDF 写门禁；native 普通文档仅按加密/XFA 判断（`native/pdfium/document-annotations.h:34-40`）。
- native DocMDP 权限进入协议和文档信息（`native/backend/pdfium/pdfium-worker.cpp`、`src/engine/protocol/commands.ts:77-79`、`src/core/pdf-types.ts:97-103`）。
- uncertain 状态在 metadata 中变成风险字段而非 read-only（`src/adapters/host/pdfium/document-metadata.ts:87-106`）。
- Reader 与模型保存都提示风险；P=1 有额外确认（`src/client/viewer/controllers/use-reader-save.ts:188-202`、`src/adapters/host/dsh/model-write-tools.ts:100-161`）。
- 加密且已签名仍被严格阻断（`src/modules/working-copy/service.ts:667-675`、`src/modules/working-copy/save.ts:39-47`）。

### 代码与测试精简度

- 产品 TS/TSX：374 文件、41,660 行；测试 TS/TSX：65,979 行。测试量约为产品代码 1.58 倍，结构按 modules/adapters/entrypoints/browser/native 分层（`docs/testing.md:3-15`）。
- `TODO/FIXME/HACK/XXX` 扫描无命中。
- 架构门禁通过：375 文件、42,156 行，无 Host/Client inversion、无 feature cycle。
- 当前变更为 56 个已跟踪文件 + 4 个新增文件；净变更约 +845/-396。属于跨 Client/Host/native/contract/docs 的大型发布，不应绕过完整 CI。
- 新增 uncertain 语义的 metadata/status 覆盖存在（`tests/adapters/pdfium/document-metadata.test.ts:84-114`、`tests/adapters/host/dsh/document-status.test.ts:64-84`），但 `tests/modules/viewer/use-reader-save.test.ts` 没有 signed/uncertain 场景；模型测试只覆盖 P=1，而非 uncertain 保存风险（`tests/adapters/host/dsh/agent-tools.test.ts:717-748`）。

## 文档审计

### 已同步

- README 中英、spec、architecture、agent tools 和 working-copy model 已纳入当前抽象及 baseline mismatch/password 语义（`README.md:78`、`README.zh.md:78`、`spec.md:7-15,19-29`、`docs/architecture.md:39-103`）。
- 签名可编辑、保存失效及 P=1 强确认写入产品规范（`spec.md:12-14`）和模型文档（`docs/working-copy-model.md:42`）。
- 本地 25 份主 Markdown 的相对链接检查：0 broken。
- package `files` 包含 testing/releasing/working-copy model/examples/coverage 等发布文档（`package.json:50-75`）。

### 仍需处理

- `docs/working-copy-model.md` 为英文，而架构/spec/testing 主文档为中文；内容正确，但格式语言未统一。
- README 没有面向普通用户说明“已签名/可能签名可编辑，保存使签名失效”；该行为只在 spec/内部模型文档出现（README 功能列表 `README.md:9-18`）。
- 无 CHANGELOG/RELEASE_NOTES；0.1.8 若包含本次大规模语义变更，用户无法从发布包快速识别破坏性边界。
- 若发布前 bump 版本，`docs/testing.md:48`、`docs/releasing.md:47`、`docs/engine-extensions.md:27` 和 example 版本需同步；当前都与 0.1.8 一致。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm typecheck:tests` | 通过 |
| `npm run typecheck:bench` | 通过 |
| `pnpm build` / normal build | 通过 |
| native helper（PDFium 156.0.8076.0） | 通过 |
| 全量 Node suite | 2673 tests / 2672 pass / 1 skip / 0 fail |
| 签名聚焦测试 | 80/80 通过 |
| `check:architecture` | 通过 |
| `check:dsh` | 通过，runtime 0.2.2-rc.2 |
| Markdown 相对链接 | 25 docs / 0 broken |
| native package | darwin-arm64 归档验证通过 |
| main package | normal build 后归档验证通过 |
| clean install + native hello | 通过 |
| SDK consumer smoke | 未通过；worktree 无 node_modules，临时 shim 后 consumer 又缺 `@deepseek-ai/cordis` |
| project coverage | **未通过完整流程**；Node/Worker lane启动，Web lane因缺相邻 `deepseek-harness` checkout 失败 |
| Web E2E | 本轮未取得成功结果 |

### 覆盖率判断

不能声称“代码覆盖率达 100%”。`coverage.md:40-44` 明确项目门禁只是 **line coverage**，不是 branch/function/interaction/platform/behavior 100%。即使 CI line gate 成功，也不能称总体代码覆盖率 100%。本轮当前源码的 `test:coverage:project` 又因缺少相邻 DSH Web 宿主而失败，因此连当前 commit 的 100% project line coverage 也没有证明。

## 发布包与分发

- package 版本：0.1.8，MIT，公开 npm（`package.json:2-13,203-209`）。
- npm dry-run：301 文件；压缩约 55.6 MB，解包约 101.9 MB。体积主要来自 CJK 字体、PDFium 和多份 Tesseract WASM；属功能资产，不是简单死代码。
- CI 设计要求五平台 native build、clean install、Web、100% project line coverage 后才允许发布（`.github/workflows/native.yml:51-127,159-258`；`docs/releasing.md:74-79`）。当前本地证据尚未满足该标准。

## 发布前必须完成

1. 提交或整理当前 60 项变更，生成可复现 release candidate commit。
2. 在存在相邻、固定版本 DSH checkout 的环境运行 `npm run test:web` 和 `npm run test:coverage:project`，要求成功且报告当前源码 100% project **line** coverage。
3. 补 `signatureUncertain` 的 Reader 保存确认测试、Reader notice 测试、模型 save-risk 测试；必要时添加浏览器 E2E。
4. 在标准 `npm ci` checkout 中重跑 main/native package smoke，确保四个 SDK consumer 全通过。
5. 增加 0.1.8 release notes/CHANGELOG，明确 working-copy 模型、加密模型入口与签名失效语义。
6. 决定文档语言规范：将 working-copy model 中文化，或明确架构文档允许英文设计契约；README 增加用户可见签名行为。
7. 让 GitHub Actions 五平台和发布门禁在该 commit 上全绿，再发布。

## 特点与不足

### 客观事实

- 领域模型、协议 schema、native事实、Host策略与 UI确认分层明确；签名不是用 UI 特例实现。
- 测试数量与测试/产品代码比高；完整 Node suite 当前为零失败。
- CI 发布链设计严格，含五平台 native、clean install、Web 和 line coverage gate。
- 当前工作树大且未提交；本轮无法取得完整 Web/coverage/package-smoke成功证据。

### 主观评价

- **工程主体接近发布质量，但当前候选版本尚未达到仓库自己定义的发布标准。**
- 最大风险不是明显功能错误，而是“新跨层语义尚未由完整浏览器/coverage/release archive链证明”。
- 代码并非明显冗余，但 service 编排集中、测试体量巨大；发布前不宜再做无目标压缩，应优先补关键交互覆盖和可复现 CI 证据。

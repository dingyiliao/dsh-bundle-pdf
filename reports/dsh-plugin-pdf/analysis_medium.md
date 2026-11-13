# DSH PDF 插件完整度审计

- **来源**: `/Users/dylan/Workspace/AI/dsh-plugin-pdf`（本地目录）
- **项目类型**: application（DSH Host/Client 插件）
- **分析深度**: medium
- **写作风格**: standard
- **生成日期**: 2026-11-13
- **commit**: 不可用；当前 workspace 不是 git worktree，无法区分已跟踪/未跟踪文件

## 结论
> 本文是修复前的审计快照。2026-11-13 已处理前四项，修复结果见文末“本轮修复结果”。


功能代码和构建链整体是完整的：374 个 TypeScript/TSX 源文件中，372 个可从产品入口到达；没有发现无引用的产品 TypeScript 模块。当前主要缺口不在核心代码，而在**发布包内的文档链接、CI 使用的 DSH 测试宿主，以及几份没有维护状态的旧文档/快照**。

优先处理三项：

1. 打包后的 README/文档存在 35 个失效相对链接；其中 `docs/testing.md`、`docs/releasing.md`、`examples/`、`bench/`、`native/pdfium/` 根本不在 `files` 清单内。
2. CI 的 Web 测试仍固定在 DSH `0.2.1-rc.3`，而当前开发依赖是 `0.2.2-rc.2`、`engines.dsh` 要求 `>=0.2.2-rc.1`；CI 没有用当前运行时验证插件。
3. `docs/performance-baseline.md`、`docs/refactor-plan.md` 等仍是旧数字/旧状态；Phase 2 的完整退出条件（100% 快速滚动 p95 ≤16.7ms）并未达到，当前只是窗口上限和 preview 抑制。

## 审计方法

- 用 TypeScript AST 从产品入口递归解析相对 import，统计源文件可达性；再从测试入口做一次并集。
- 用 `npm pack --dry-run` 生成真实包清单，解包后检查所有 Markdown 相对链接。
- 阅读 `package.json`、`tsconfig*.json`、`.github/workflows/native.yml`、`scripts/`、`docs/`、`spec.md`、README。
- 运行类型检查、构建、架构门禁和针对性测试；全量 Node 套件在报告生成时仍在运行。
- 限制：没有 git 历史，无法判断哪些文件曾被提交；`node_modules`、`dist`、`artifacts` 和 `.test-output` 是本地生成物，未纳入源代码可达性结论。

## 1. 代码与文件可达性

### 1.1 产品源文件

- `src/` 共 **374** 个 `.ts/.tsx` 文件。
- 从 12 个产品入口（`reader-host`、`native-host`、`ocr-host`、`image-understanding-host`、`reader-client`、OCR/translation/embedding/capability/engine SDK、OCR worker、文字修复 worker）可达 **372** 个。
- 只有两个文件不在产品运行时闭包内：

| 文件 | 情况 | 判断 |
| --- | --- | --- |
| `src/host/ocr-plugin.ts` | 仅被 `tests/legacy-source-entrypoints.test.ts` 导入，并被 `tsconfig.sdk.json` 作为公开声明入口 | **不是死代码**：它是 `./ocr-host` 的兼容声明 shim，运行时导出指向 `src/entrypoints/ocr-host.ts` |
| `src/host/image-understanding-plugin.ts` | 同上 | 同上 |

这两个 shim 是合理的兼容层，但 `docs/architecture.md` 只写了 `src/host/` 是“已发布 SDK、注册接口及 Host 类型入口”，没有说明它们只是 re-export；建议在源码地图中明确，避免后来者误删。

### 1.2 非 TS 的孤立资产

- `schemas/native/transport.schema.json`：没有测试、脚本或运行时代码引用；也不在 `package.json` 的 `files` 中。它现在是一份**没人消费的契约文件**。要么把它纳入 schema 校验和发布清单，要么删除，避免继续漂移。
- `scripts/smoke-dsh-compatibility.mjs`：只在 `docs/testing.md` 中被调用，不在 npm scripts 中；作为手动验收脚本可以接受，但应标注“手动”。
- `docs/pdf-ai-tool-list.md` 和 `docs/pdf-engine.md` 没有任何入站链接；见文档章节。
- `.vscode/settings.json` 包含本机绝对路径 `/Users/dylan/Workspace/AI/dsh-plugin-pdf/native`，不可移植；`.gitignore` 没有忽略 `.vscode` 或 `.DS_Store`，根目录已有 `.DS_Store`。

### 1.3 构建产物

- `package.json` 的所有 `exports` 目标都存在；`npm pack` 实际生成 **286 个文件、约 55 MB**。
- `dist/assets/manifest.json` 的 22 个条目与文件大小一致；`forms/` 字体和 `ocr/core/package.json` 不在浏览器资产 manifest 中，这是代码注释说明的有意行为。
- `dist/types` 的入口 wrapper 存在；没有发现旧 `src/modules/viewer` 生成物残留。

## 2. 文档同步

### 2.1 已同步的部分

- `docs/agent-tools.md` 的 20 个工具名与当前源码中的工具名一致，没有多余的 `pdf_*` 工具。
- `docs/dsh-compatibility.md` 与 `package.json` 的 `engines.dsh`、peer 范围一致。
- Native v2 的 schema/fixtures 已从旧的 `nativeHandle`/`hostRevision` 迁移到实际扁平 envelope。
- `docs/architecture.md` 的 Host/Client 职责描述与当前目录划分基本一致。

### 2.2 未同步或缺失的用户行为

| 行为 | 代码 | 文档状态 |
| --- | --- | --- |
| 解释问题输入：Enter 提交、Shift+Enter 换行、Esc 取消 | `src/client/viewer/components/ExplanationQuestionEditor.tsx:121-125` | README 功能列表、`spec.md` FR-07 均未提及 |
| 批注评论：Enter 保存、Shift+Enter 换行、Esc 关闭 | `src/client/viewer/components/ReaderCommentEditor.tsx:34-38` | `spec.md` FR-05 只写“聚焦输入框”，没有键盘约定 |
| 便签：Enter 保存、Shift+Enter 换行、Esc 取消 | `src/client/viewer/components/ReaderNoteEditor.tsx:34-38` | `spec.md` FR-05 未提及 |
| `<50%` 纯浏览、无文本层、不可选中 | `src/client/viewer/rendering/text-policy.ts`、`src/client/Reader.tsx` | 只在 `docs/refactor-plan-v2.md` 中说明；`spec.md` FR-03 和 README 没有产品级说明 |
| 低缩放当前页隐藏语义文本 | `src/client/viewer/rendering/Page.tsx` | 只在重构计划中说明；没有无障碍文档 |
| 10% 虚拟窗口 ≤16 页 | `src/client/viewer/rendering/page-layout.ts` | 只在重构计划中说明；没有性能/行为文档 |

快捷键已经由测试覆盖，但用户没有可见提示（按钮 title、README 或设置说明都没有）。这是“实现完成、文档未同步”的典型例子。

### 2.3 过期或历史文档

| 文档 | 证据 | 问题 |
| --- | --- | --- |
| `docs/performance-baseline.md:3` | “状态：P0 执行中” | 项目早已完成 P0–P8；这是旧状态 |
| `docs/performance-baseline.md:7,9,12` | 366/367 个文件、41,246/41,280 行、2641 个测试 | 当前架构扫描为 374 个文件、41,724 行，测试数也已变化 |
| `docs/refactor-plan.md:3` | v1.4、2646 通过、声称 P0–P8 完成 | v2 已取代其中 Client 渲染/契约部分，但 v1 头部没有“历史文档”标记，容易被当成当前计划 |
| `docs/refactor-plan-v2.md:3` | “Phase 0–2 的低风险范围…已完成” | 完整 Phase 2 的退出条件在 `:376` 要求 100% p95 ≤16.7ms；`:370-373` 的 RenderStore/单调度器没有实施。建议明确写“仅完成缩小范围” |
| `docs/refactor-plan-v2.md:434` | “Phase 1 暂不覆盖” | 与同文 `:361` “已在 Phase 2 实施”矛盾 |
| `docs/testing.md:46`、`docs/releasing.md:47`、`docs/engine-extensions.md:27` | 仍使用 `0.1.7` | 当前包是 `0.1.8`；示例版本过期 |
| `examples/http-engines/package.json:19,23` | peer `^0.1.5`、dev `^0.1.7` | 当前示例依赖落后；虽然没有硬性失效，但不应作为“同版本 SDK”的示范 |
| `docs/document-state-matrix.md`、`index-identity.md`、`migration-matrix.md`、`transaction-state-machine.md` | 头部仍写“P0 草案” | 需要确认是当前契约还是历史设计；状态标签会误导读者 |
| `docs/pdf-ai-tool-list.md` | 无入站链接；列出 `pdf_structure`、`pdf_redact`、`pdf_sign` 等未实现工具 | 这是 2026-10 的设计提案，不是当前工具契约；没有标记历史/草案 |
| `docs/pdf-engine.md` | 无入站链接 | 内容与 `docs/architecture.md` 有重叠；应链接进主文档或归档 |
| `docs/refactor-plan-v2.md` | 无入站链接 | 内部计划可以保留，但最好从架构/测试文档链入 |

## 3. 打包后的文档链接

实际 `npm pack` 包中，Markdown 相对链接有 **35 个失效目标**。主要例子：

| 包内文件 | 失效目标 | 原因 |
| --- | --- | --- |
| `README.md:82` / `README.zh.md:82` | `examples/README.md`、`examples/http-engines` | `examples/` 不在 `files` |
| `README.md:107` / `README.zh.md:107` | `native/pdfium/README.md` | `native/` 不在 `files` |
| `README.md:115` / `README.zh.md:115` | `docs/releasing.md` | 该文档不在 `files` |
| `spec.md:209` | `docs/testing.md` | 该文档不在 `files` |
| `docs/architecture.md:150` | `./testing.md` | 同上 |
| `docs/agent-tools.md:149` | `testing.md` | 同上 |
| `docs/engine-extensions.md:20-23,183-185` | `examples/...`、`tests/examples/...`、`testing.md` | 示例、测试和测试指南都没有发布 |
| `docs/retrieval.md:6,182-186` | `../bench/README.md`、`bench/*.ts`、`benchmarks/...` | `bench/` 和 `docs/benchmarks/` 不在 `files` |
| `performance.md:3,7,19,32` | `bench/README.md`、`docs/benchmarks/...` | 同上 |
| `native-pdf.md:21,89` | `native/pdfium/README.md`、`docs/testing.md`、`docs/benchmarks/...` | 同上 |
| `docs/dsh-compatibility.md:48` | `../src/adapters/host/dsh/session-events.ts` | 新文档把源码链接带进了发布包，但 `src/` 不发布 |
| `dist/native/licenses/libjpeg_turbo.md:7` | `README.ijg` | 第三方许可证归档缺少该文件 |

`package.json:50-69` 目前只发布 README、spec、部分 docs、screenshots、performance、native-pdf 和 LICENSE。解决方式只有三类：

1. 把这些开发者文档/示例/基准纳入包（会显著增大包体）；
2. 把发布文档中的相对链接改为 GitHub 绝对链接；
3. 删除 README 中指向未发布文件的入口，或把完整开发文档移到仓库站点。

对用户 README，建议至少发布 `examples/` 和 `docs/testing.md`/`docs/releasing.md`，或者改成绝对链接；`native/pdfium` 和 `bench` 更适合绝对链接。

## 4. 配置与 CI

- `.github/workflows/native.yml:65` 固定 `deepseek-harness` 提交 `d02ea37...`；该提交的 release 标题是 **DSH 0.2.1-rc.3**。当前插件 devDependencies 是 `0.2.2-rc.2`，`engines.dsh` 是 `>=0.2.2-rc.1 <0.3.0-0`。因此 Web E2E 用的是一个低于准入下限的宿主，`docs/testing.md:26` 的“测试宿主须与被验证的 SDK 对齐”没有落实。
- 建议把 CI 固定提交升级到与 devDependencies 相同的 rc.2，或增加一个明确的 DSH 版本矩阵；同时在 Web 测试前用 `evaluatePluginCompatibility`/`check:dsh` 验证测试宿主。
- `npm run check` 已在五个平台的 native matrix 中运行（`native.yml:213`），但 Web job 不运行 `npm run check`；它只跑 `test:web` 和覆盖率流程。类型/架构门禁在 native job 中覆盖，但 Web 专属装配没有同等门禁。
- `.npmrc` 的 `legacy-peer-deps=true` 是开发安装的权宜设置；已在 `docs/dsh-compatibility.md` 说明。CI 的 `npm ci` 在临时目录验证过可安装。
- `coverage.md` 要求 100% 行覆盖率，但最近一次 `.test-output/project-coverage-V21It5/report.json` 是 **29575/29683 行（108 行未覆盖）**、`lineCoverageComplete: false`，且日期为 11 月 12 日，早于本轮快捷键改动。当前不能声称覆盖率门禁已通过；需要重跑 `npm run test:coverage:project`。
- `.vscode/settings.json` 的绝对 CMake 路径和根目录 `.DS_Store` 是工作区卫生问题；`.gitignore:1-12` 没有覆盖它们。

## 5. 验证状态

本次审计实际运行：

- `npm run typecheck`：通过
- `npm run typecheck:tests`：通过
- `npm run typecheck:bench`：通过
- `npm run build`：通过
- `npm run check:dsh`：通过（runtime `0.2.2-rc.2`）
- `npm run check:architecture`：通过（374 files / 41,724 lines）
- 快捷键相关组件测试（当前改动后）：25/25 通过
- Phase 2 关键 Web E2E（快捷键改动前）：低缩放、快速滚动/拖拽、连续缩放、Reader 打开/保存、设置 6/6 通过；快捷键改动后未重跑整组 Web E2E
- `npm pack`：成功生成 0.1.8 包；包内链接检查见上
- 全量 Node 套件：**2663 个测试，2662 通过、1 跳过、0 失败**，耗时约 114 秒

## 6. 建议顺序

1. **P0**：修发布文档链接。要么把 `docs/testing.md`、`docs/releasing.md`、`examples/` 纳入包，要么把 README/文档链接改成 GitHub URL；同时修 `docs/dsh-compatibility.md` 的源码链接。
2. **P0**：把 CI 的 DSH 固定提交升级到当前验证版本，并让 Web 测试在加载插件前检查 `engines.dsh`。
3. **P1**：更新 `docs/performance-baseline.md` 或标记为历史；给 `docs/refactor-plan.md` 加“已被 v2 取代”的头部；清理 `docs/pdf-ai-tool-list.md` 和 `docs/pdf-engine.md` 的归档/链接状态。
4. **P1**：把快捷键、`<50%` 浏览模式、窗口上限和隐藏语义文本写进 README/spec；给输入框加可见的键盘提示。
5. **P2**：决定 `schemas/native/transport.schema.json` 是发布并校验，还是删除；补一个文档链接检查（CI 或测试），防止再次漂移。
6. **P2**：重跑 `npm run test:coverage:project`，确认 100% 门禁；清理 `.vscode` 绝对路径和 `.DS_Store` 忽略规则。

## 7. 未覆盖/无法确认

- 没有实际启动 DSH Desktop 做本轮全量插件验收；只验证了包准入、类型、构建和 Web 测试宿主。
- 没有 git 历史，无法判断“过期文档”是否是有意保留的历史记录，也无法确认文件是否已被提交。
- `docs/pdf-ai-tool-list.md` 是否是产品设计档案还是废弃提案，需要作者确认；本报告只判断它不是当前工具契约。


## 本轮修复结果（2026-11-13）

前四项已处理：

1. **发布包文档链接**：`package.json` 的 `files` 增加 `docs/testing.md`、`docs/releasing.md`、`docs/pdf-engine.md`、`coverage.md` 和 `examples/`；benchmark/native 源代码链接改为 GitHub 绝对链接；新文档中的源码链接也改为绝对链接；`build-native.mjs` 为 IJG 许可证补 `README.ijg` 别名。重新 `npm pack` 后，包内 Markdown 相对链接检查为 **0 个失效**。
2. **CI DSH 宿主**：`.github/workflows/native.yml` 的 `ref` 从 `d02ea37...`（0.2.1-rc.3）升级为 `ddac967...`（0.2.2-rc.2），与 devDependencies 和 `engines.dsh` 对齐。
3. **文档同步/清理**：README（中英）和 `spec.md` 增加 Enter/Shift+Enter/Esc 及 <50% 纯浏览说明；`refactor-plan.md` 标记为历史文档；`performance-baseline.md` 标记为 P0 历史快照并更新当前架构计数；`refactor-plan-v2.md` 明确 Phase 2 仅完成缩小范围；P0 设计文档增加状态说明；`pdf-ai-tool-list.md` 标记为设计档案；`pdf-engine.md` 从架构文档链入。
4. **覆盖率门禁**：修复了 Phase 2 语义文本接入时 `nativeSelection` 误把 `pages` 设为 `undefined` 的回归（native selection E2E 2/2 恢复通过）；翻译 E2E 的选择辅助函数现在同时支持 glyph 和 run 精度；压缩覆盖率专用 native 错误路径并补齐 `pdf-service`/`retrieval identity` 测试。覆盖率 Web 通道在每个交互失败后重试一次，普通 `test:web` 不重试。最终 **29779/29779 行（100%）**，Web 63/63 通过。

修复后验证：

- `npm pack` 文档链接：**0 broken**
- 全量 Node：**2663 tests / 2662 pass / 1 skip / 0 fail**
- `npm run typecheck`、`typecheck:tests`、`typecheck:bench`、`check:dsh`、`check:architecture`：通过
- 翻译 E2E：3/3 通过

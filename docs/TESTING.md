# 测试地图

测试分成三层：独立的业务/适配器用例（Node）、真实浏览器交互用例（Web），以及原生 PDFium 集成用例。`bench/` 衡量性能，不属于正确性覆盖率。测试文件按被测模块放在 `tests/` 下，`fixtures/`、`expected/` 和 `native-fixture.ts` 提供数据与测试辅助设施。

| 入口 | 测试内容 | 运行命令 |
| --- | --- | --- |
| `tests/**/*.test.ts` | Node 的单元与集成 TC：核心规则、工具、工作副本、PDF 操作、组件事件与边界条件 | `npm test` |
| `tests/web.e2e.ts`、`tests/client-panels.e2e.ts` | Chromium 中的真实 Reader、侧栏、缩放、批注与翻译交互 | `npm run test:web` |
| `tests/browser/ocr-local-worker.test.ts` | 浏览器 Worker/OCR 启动冒烟测试 | 项目覆盖率流程自动运行 |
| `tests/native-integration.test.ts` 等 `native-*` 用例 | PDFium 协议、渲染、文本、保存等原生路径 | `npm test`；插桩版由项目覆盖率流程运行 |

`tests/modules/` 对应 `src/modules/`：`viewer/` 测组件和页面交互，`evidence/` 测 AI 读取/定位，`navigation/` 测书签和跳转，`model-write/` 测模型批注与保存审批，`working-copy/` 测草稿及冲突，`ocr/`、`explanation/` 等各测自己的领域规则。`tests/adapters/` 测 DSH、PDF 库、存储及客户端适配边界；`tests/entrypoints/` 测 Host/Client 装配和清理；根目录的 `contracts-*`、`compatibility-*`、`settings-*`、`pdf-*` 等文件覆盖跨模块契约、兼容性、设置和完整文档生命周期。`tests/browser-coverage.ts` 是覆盖率采集辅助代码，不是产品 TC。

## TC 与覆盖率

TC 是一个有明确输入和预期结果的测试用例。`npm test` 的 TC 数按 Node test runner 报告；`npm run test:web` 按 Vitest 报告；它们不能简单相加来代表覆盖率。一次交互 TC 可覆盖许多源码行，多条 TC 也可能重复走同一路径。

`npm run test:coverage:project` 分别采集 Node/Host、Browser/Client 的 V8 覆盖率和原生 C++ 的 LLVM 覆盖率，再按源码路径及行号合并。分母是 `src/` 中会产出 JavaScript 的源码行，以及 `native/pdfium-worker.cpp` 的可测行；排除类型声明、静态导入导出、纯结构行、测试、构建脚本和第三方 PDFium。报告位于命令打印的 `.test-output/project-coverage-*/report.json`，包含逐文件未覆盖行。仓库目前将**项目源码行覆盖率 100%**设为通过条件；即使所有 TC 都通过，只要仍有未覆盖行，该命令也会失败。它不是分支覆盖率或“没有缺陷”的保证。

## 常用命令

```sh
npm run check                  # TypeScript（源码、测试、bench）+ Node TC
npm run test:web               # Chromium 交互 TC；需要相邻的 deepseek-harness 仓库
npm run test:coverage:project  # 全项目三条运行通道；需要 Node 26.7+、Chromium 和原生构建环境
npm run bench                  # 性能基准，结果不计入正确性覆盖率
```

项目覆盖率运行期间不要修改 `src/`、`tests/` 或构建配置；脚本会验证输入指纹，并在结束后恢复普通 Desktop 构建。局部调试可用 `node --import tsx --test tests/<path>.test.ts`，但最终仍需跑完整套件。

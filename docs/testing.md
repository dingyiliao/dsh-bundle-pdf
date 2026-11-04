# 测试指南

## 测试分层

| 位置 | 验证范围 | 命令 |
| --- | --- | --- |
| `tests/modules/` | 工作副本、证据、导航、OCR、解释及 Viewer 领域规则 | `npm test` |
| `tests/adapters/` | DSH、PDF 库、存储及 Client 适配边界 | `npm test` |
| `tests/entrypoints/` | Host／Client 装配、注册及资源清理 | `npm test` |
| 根目录 `contracts-*`、`settings-*`、`pdf-*` 等 | 跨模块契约、设置和文档生命周期 | `npm test` |
| `tests/browser/e2e/*.e2e.ts` | 按功能划分的 Chromium Reader 和面板交互 | `npm run test:web` |
| `tests/native-*.test.ts` | PDFium 协议、渲染、文字及保存集成 | `npm test` |
| `tests/browser/ocr-local-worker.test.ts` | 构建后的浏览器 OCR Worker 启动 | 项目覆盖率流程 |

`tests/fixtures/`、`tests/expected/` 和 `native-fixture.ts` 提供测试数据；`tests/support/` 统一临时 DOM 环境的创建和恢复，各场景保留自己的 mock。`tests/browser-coverage.ts` 是采集辅助代码。`bench/` 衡量性能，运行方式见[基准指南](../bench/README.md)。

## 运行

```sh
npm run check                 # 源码、测试及 bench 类型检查，构建和 Node 测试
npm run test:web              # 浏览器交互
npm run test:coverage:project # Node、Browser 和 native 合并覆盖率
node --import tsx --test tests/<path>.test.ts
```

浏览器测试需要相邻的 `deepseek-harness` 仓库及其已构建产物、Playwright Chromium 和本地 HTTP 监听权限。测试宿主版本须与被验证的 SDK 对齐；CI 的固定提交见[工作流](../.github/workflows/native.yml)。原生测试需先运行 `npm run native:build`。

使用非默认位置的 Chromium 时，将 `DSH_PDF_BROWSER_EXECUTABLE` 设为其可执行文件的绝对路径。

项目覆盖率要求 Node 26.7+、Chromium 及 LLVM 工具链。采集期间保持源码和构建配置不变；报告写入命令打印的 `.test-output/` 目录。分母、合并方法及 100% 行覆盖率门槛见[覆盖率口径](../coverage.md)。TC 数量不代表覆盖率。

## 跨边界验证

- **SDK 和卸载**：运行 `runtime-compatibility` 与版本准入测试，验证实际 SDK 调用、Fiber 注销和存储边界；支持新版本还需验证 Loader 装配。
- **退出与更新**：被动订阅须及时返回，取消及卸载排空任务；更新锁既要结束观察请求，也要等待已接纳写入。真实安装更新另外检查旧 Host 退出、安装器交接和新进程启动。
- **模型功能**：受控模型流验证请求、协议、截断和展示；真实 Runtime 集成验证适配边界；在线模型验收验证识别、翻译及解释质量，分别报告结果。
- **翻译**：原选区和有界上下文须实际经过 Host 适配器；由模型判断残缺内容及修复，不以固定残词规则拒绝输入。浏览器测试走完整请求链，在线验收核对原文、修复说明和结果。
- **文件互操作**：用外部阅读器核对保存后的标注、回复、书签及表单值和外观；自动化协议测试不能代替文件互操作。

报告区分完整运行、过滤运行、跳过和失败。缺失宿主或测试夹具导致的失败不得记为通过；单一通道的覆盖率不代表全项目覆盖率。

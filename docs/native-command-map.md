# Native 命令映射

状态：P1/P2 已完成。现有 command 仍是运行时事实；请求/回复关联已由 `src/engine/protocol/transport.ts` 收敛，PDFium service 的现有调用方已迁移到 `NativePdfPort` 显式方法。`native/worker/worker-runtime.{h,cpp}` 与 `native/backend/pdf-backend.h` 已将 framing/进程生命周期和 PDF 行为分离。

## 传输层

| 当前 command | 目标 NativePdfPort | 上下文 | 主要调用方 | 验收 |
| --- | --- | --- | --- | --- |
| `hello` | `handshake` | 无文档上下文 | Native worker client、兼容性检查 | `native-protocol.test.ts` |
| `open` | `open` | `OpenRequest` | document port、working copy | `native-document-port.test.ts`、加密测试；已迁移到 `NativePdfPort.openDocument` |
| `close` | `close` | `DocumentContext` | document port、生命周期 | `pdf-session-lifecycle.test.ts`；已迁移到 `NativePdfPort.closeDocument` |
| `security` | `inspectSecurity` | `DocumentContext` | encryption、working copy | `native-encrypted.test.ts` |

传输封装保持当前 worker 的扁平 JSON 命令和二进制帧不变：`transport.ts` 只负责生成 `requestId`、校验回复关联、区分成功/失败和委托具体 command schema 解码。这样 Native worker 可以先独立替换内部 PDF 后端，Node.js 调用方不需要知道 PDFium 类型。

## 文档事实

| 当前 command | 目标 NativePdfPort | 返回内容 | 主要调用方 | 验收 |
| --- | --- | --- | --- | --- |
| `documentInfo` | `inspectDocument` | 页数、页面框、旋转、权限 | document、reader | `native-document-metadata.test.ts` |
| `fingerprints` | `getPageFingerprints` | 逐页内容摘要 | document、retrieval | `native-page-content.test.ts` |
| `text` | `readText` | 原生文字、glyph、样式和质量 | page content、selection | `native-page-content.test.ts`、surrogate tests |
| `selectionGeometry` | `getSelectionGeometry` | 分块选区几何和游标 | client selection、evidence | `native-selection-geometry.test.ts` |
| `links` | `listLinks` | 链接、目的地和区域 | navigation、reader | `native-integration.test.ts` |
| `destination` | `resolveDestination` | 命名目的地 | navigation、model tools | `pdf-inspection.test.ts` |
| `render` | `renderPage` | RGBA 页面或 tile | reader、OCR、视觉引擎 | `native-integration.test.ts` |
| `inspect` | `inspectPageObjects` | 页面对象范围，只读 | forms、diagnostics | `pdf-inspection.test.ts` |

## 文档结构和写入

| 当前 command | 目标 NativePdfPort | 事务要求 | 主要调用方 | 验收 |
| --- | --- | --- | --- | --- |
| `documentOutlines` | `readOutlines` | 返回当前快照书签树 | outlines、model tools | `native-outline-extensions.test.ts` |
| `applyOutlines` | `mutateOutlines` | `MutationContext`、原子操作 | outlines、model tools | outline save/reopen tests |
| `annotationPages` | `listAnnotationPages` | 只读页面索引 | annotations、reader | annotation tests |
| `annotations` | `readAnnotations` | 分页、来源和回复关系 | annotations、evidence | annotation tests |
| `annotationEdit` | `mutateAnnotations` | `operationId`、revision 校验 | reader、model tools | annotation mutation tests |
| `formFields` | `inspectFormFields` | 字段身份和权限 | forms、model tools | `native-form-fields.test.ts` |
| `applyFormFields` | `mutateFormFields` | 类型、依赖和 revision 校验 | forms、model tools | form save replay tests |
| `saveCopy` | `materializeCopy` | 返回待发布快照大小 | working copy | save/recovery tests |
| `saveChunk` | `readMaterializedChunk` | 分块读取、校验和 | filesystem adapter | save transport tests |

## 契约迁移规则

1. 先为现有 command 增加目标 schema 和 golden fixture，再迁移调用方。
2. `inspect/mutate/save` 是逻辑分组，不允许用无结构的 `unknown` 替代具体操作 schema。
3. `handshake` 和 `open` 不需要已有 Native 句柄；成功 `open` 后的读取请求才携带 `DocumentContext`。
4. 写入必须携带 `MutationContext`，由 `operationId` 实现 Host 侧去重和安全重试。
5. 旧 command 只有在所有调用方、测试和诊断路径迁移后才能删除。

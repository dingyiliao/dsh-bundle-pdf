# DSH PDF 插件整体重构计划

> **历史文档**：本文件记录 v1 的 Host/Native/索引迁移方案；Client 渲染与契约治理已由 [refactor-plan-v2.md](./refactor-plan-v2.md) 取代。文中测试数字是 v1 完成时的快照，不是当前结果。

状态：实施稿 v1.4。P0–P8 的代码迁移、协议边界、PDFium patch queue、Host 领域服务、页面内容/索引、模型工具、Client/UI、构建与文档已完成；本轮继续完成了检索页面流水线和向量流水线的职责拆分。当前本地完整检查通过（2646 通过、1 跳过、0 失败）。远程 GitHub Actions 是否通过仍以对应提交的 CI 结果为准。

## 1. 重构目标

将项目整理为一套以稳定 Native 协议为边界的架构：

```text
Client / Model Tools
        ↓
Host Domain Services
        ↓
Stable NativePdfPort
        ↓
Native Worker
        ↓
PdfBackend
        ↓
PdfiumBackend
        ↓
Fixed PDFium + Patch Queue
```

Node.js 只依赖 Native 协议，不依赖 PDFium 内部类型、指针或实现细节。Native 层可以替换内部实现；当前只实现 PDFium 后端。PDFium 使用固定 upstream revision 和独立 patch 文件，不依赖长期维护的 fork。

## 2. 核心原则

1. Node.js 与 Native 完全解耦。
2. 所有 PDF 能力统一经过 Native 协议。
3. UI 和模型工具使用同一套 Host 领域能力。
4. 修改进入共享工作副本，覆盖原文件仍需用户确认。
5. 文档引用、revision、source digest 和权限由 Host 统一管理。
6. OCR、图像理解、embedding、翻译通过统一引擎注册接口扩展。
7. 只有存在独立职责、复用需求或独立测试边界时才拆分模块。
8. 新路径迁移完成后删除旧实现，不保留两套并行业务逻辑。
9. `pdf-lib` 不作为兼容后端保留，PDF 能力统一迁移到 Native/PDFium。
10. Host 负责文档事务和权威修订；Native 负责 PDF 事实和原子操作结果，不能各自维护一套提交状态。
11. Native 提供权威几何；Client 可以保留展示所需的本地坐标变换、局部命中和交互预览，提交时再由 Host/Native 校验。
12. 持久缓存身份与运行时实例身份分离；引擎卸载只影响当前调用和在途任务，不自动使可验证的历史产物失效。
13. 每个阶段都必须保持项目可构建、关键闭环可运行，并提供可复现的验收证据。

## 3. 目标目录

```text
dsh-plugin-pdf/
├── src/
│   ├── contracts/
│   │   ├── native/
│   │   ├── engines/
│   │   └── tools/
│   ├── runtime/
│   │   ├── host/
│   │   └── lifecycle/
│   ├── domain/
│   │   ├── document/
│   │   ├── working-copy/
│   │   ├── annotations/
│   │   ├── forms/
│   │   ├── outlines/
│   │   ├── navigation/
│   │   ├── content/
│   │   ├── retrieval/
│   │   └── evidence/
│   ├── engines/
│   │   ├── registry/
│   │   ├── ocr/
│   │   ├── image-understanding/
│   │   ├── embedding/
│   │   └── translation/
│   ├── adapters/
│   │   ├── native/
│   │   ├── dsh/
│   │   ├── storage/
│   │   └── filesystem/
│   └── client/
│       ├── reader/
│       ├── sidebar/
│       ├── toolbar/
│       ├── annotations/
│       ├── translation/
│       ├── explanation/
│       ├── forms/
│       └── settings/
├── native/
│   ├── worker/
│   ├── protocol/
│   ├── backend/
│   │   └── pdfium/
│   ├── pdfium/
│   │   ├── extensions/
│   │   ├── patches/
│   │   ├── build/
│   │   └── dependencies.json
│   └── CMakeLists.txt
├── tests/
├── examples/
├── docs/
└── scripts/
```

顶层不再保留重复的 `pdf_engine`、`native`、`src` PDF 能力实现。Node 侧的 PDF 领域逻辑归入 `src/domain`，Native 侧归入 `native/backend`，PDFium 扩展和补丁归入 `native/pdfium`。

### 3.1 现状到目标的迁移原则

当前已有 Native 协议、独立文档 Worker、工作副本端口、统一页面内容、引擎目录、持久索引和跨平台构建链。本次不是从零重写，而是按以下方式迁移：

| 当前实现 | 目标处理 | 迁移要求 |
| --- | --- | --- |
| `src/engine/protocol` | 收敛为版本化 `NativePdfPort` 契约 | 先建立命令映射表，再迁移调用方 |
| `src/engine/host/native-worker` | 继续作为 Host 侧 Worker 客户端 | 保留进程隔离、取消和超时语义 |
| `src/adapters/host/pdfium` | 收敛为 Native Adapter | 只做协议转换，不承载领域状态 |
| `src/modules/working-copy` | 保留为工作副本领域服务 | 明确事务、恢复和发布边界 |
| `src/modules/retrieval` | 拆分任务调度、检查点和查询执行 | 先拆职责，再决定目录改名 |
| `src/client/Reader` | 拆分渲染、视口、交互和浮层组合 | 保留本地交互热路径 |
| `native/pdfium` | 统一为 extensions、patches、build | 复用现有 PDFium 锁定和构建脚本 |

每个迁移项必须记录：当前文件、目标文件、调用方、数据格式、删除项、针对性测试和完成证据。目录改名本身不算重构完成。

### 3.2 本轮增量拆分

检索服务的页面恢复、缓存迁移、内容抽取、几何分块和检查点写入已迁移到
`src/modules/retrieval/page-pipeline.ts`；文档/页面摘要身份和 embedding 配置身份
统一位于 `src/modules/retrieval/identity.ts`；页面抽取失败的边界契约位于
`src/modules/retrieval/validation.ts`。`service.ts` 仍负责索引生命周期、并发、查询和
结果校验，不再直接承载单页恢复与抽取细节。迁移保留原有公开 `RetrievalService` 接口，
并由检索回归测试覆盖旧缓存迁移、失败恢复、向量复用和跨会话边界。

向量批处理、跨页工作窗口、向量缓存复用、批量 embedding 和 checkpoint 提交已迁移到
`src/modules/retrieval/embedding-pipeline.ts`。该模块通过只读上下文调用索引服务的
容量、修订和持久化端口；索引服务仍拥有生命周期、并发和查询授权。向量流水线会在开始
时快照活动索引的驻留字节，避免重复消费单次迭代器而错误计算内存预算；其低预算窗口、
失败后续跑、批量复用和跨服务重启复用由检索性能与持久化测试覆盖。

## 4. Native 协议

### 4.1 稳定接口

```ts
interface NativePdfPort {
  handshake(): Promise<NativeCapabilities>
  open(request: OpenRequest): Promise<OpenResult>
  close(request: CloseRequest): Promise<void>
  inspect(request: InspectRequest): Promise<InspectResult>
  render(request: RenderRequest): Promise<RenderResult>
  readText(request: ReadTextRequest): Promise<ReadTextResult>
  getSelectionGeometry(request: SelectionRequest): Promise<SelectionResult>
  mutate(request: MutationRequest): Promise<MutationResult>
  save(request: SaveRequest): Promise<SaveResult>
  unlock(request: UnlockRequest): Promise<UnlockResult>
}
```

`handshake` 和 `open` 不要求已有文档上下文；`open` 使用独立的 `OpenRequest`，成功后返回 Native 句柄和快照身份。其余文档请求携带文档上下文；传输 envelope、会话上下文、文档上下文和变更上下文分开定义。协议必须支持版本协商、能力报告、结构化错误、取消、超时、进度和 revision 冲突。

```ts
interface TransportEnvelope {
  protocolVersion: string
  requestId: string
  traceId?: string
  deadlineMs?: number
  cancelToken?: string
}

interface DocumentContext {
  documentId: string
  nativeHandle: string
  sourceDigest: string
  hostRevision: number
}

interface MutationContext extends DocumentContext {
  transactionId: string
  expectedRevision: number
  operationId: string
}
```

`handshake` 和 `open` 不携带已有文档上下文；`open` 创建 Native 句柄，读取请求使用 `DocumentContext`，写入请求使用 `MutationContext`。`requestId` 只关联一次传输；`operationId` 才用于 Host 侧去重和安全重试。

### 4.2 文档句柄与事务边界

协议中必须区分以下身份：

- `documentId`：Host 维护的逻辑文档身份；
- `sourceDigest`：源文件字节内容摘要；
- `sourceObservation`：路径、mtime、size 等文件系统观察信息，只用于发现外部变更；
- `nativeSnapshotId`：Native 打开的不可变快照身份；
- `hostRevision`：工作副本修订号；
- `nativeHandle`：Native Worker 内部句柄；
- `workerGeneration`：Worker 重启代次；
- `requestId`：请求关联 ID，不单独提供写入幂等保证。

Host 是提交事务的权威所有者。本项目采用 **Host 持有操作日志、Native 物化隔离快照** 的模型：

1. Host 持有不可变源版本和工作副本操作日志；
2. Native 打开只读快照，不维护跨请求的权威草稿；
3. `mutate` 接收经过 revision 校验的操作批次，返回物化结果、实际文档事实和新内容摘要；
4. Host 原子持久化操作日志、派生状态和新 revision；
5. 保存时由 Native 物化到临时文件，Host 完成校验后原子发布或另存为。

因此 Native 句柄可以在 Worker 重启后丢弃并重建，不能出现 Host 草稿和 Native 草稿两套权威状态。写入请求必须定义：成功、PDFium 失败、响应丢失、重复操作、排队取消、执行中取消、Host 持久化失败和原文件发布成功但清理失败的状态转换。只有 `operationId` 未提交时允许安全重试；无法判定提交状态时先查询事务状态，不直接重放。

### 4.3 现有命令映射

P0 阶段必须生成一张命令映射表，至少覆盖：打开/关闭、渲染、文字、选区几何、页面指纹、表单、书签、批注、链接、命名目的地、页标签、保存分块和解锁。每一项都要注明新请求类型、响应类型、错误码、调用方和回归测试；公开分组可以保持 `inspect/mutate/save`，但不能用宽泛操作代替具体 schema。

### 4.4 Native 内部接口

```cpp
class PdfBackend {
 public:
  virtual DocumentInfo Inspect(...) = 0;
  virtual RenderResult Render(...) = 0;
  virtual TextResult ReadText(...) = 0;
  virtual MutationResult Mutate(...) = 0;
  virtual SaveResult Save(...) = 0;
};

class PdfiumBackend : public PdfBackend {};
```

Worker 只负责进程生命周期、协议解析、任务调度和序列化；具体 PDF 行为由 Backend 负责。

## 5. PDFium 管理

`native/pdfium/dependencies.json` 记录 upstream revision、SDK 版本和 patchset hash。

```text
checkout fixed revision
→ git apply --check patches
→ apply patches
→ build PDFium
→ build Native Worker
→ record revision + patchset hash
```

`extensions/` 用于增加 DSH 公开能力，例如表单、书签、元数据和批注；`patches/` 只用于修改 PDFium 内部行为，例如字段身份、字体、对象代数等。若 patch 被 upstream 接受，则删除本地 patch 并调整能力报告。

升级 PDFium 时必须在干净检出上重新应用补丁；任何偏移、冲突或 API 变化都应让构建直接失败，不能静默跳过。

## 6. Host 领域层

Host 是文档状态的唯一来源。

- `document`：打开、关闭、共享文档引用和生命周期。
- `working-copy`：草稿、revision、撤销、重做、保存和丢弃。
- `annotations`：高亮、下划线、删除线、批注和便签。
- `forms`：AcroForm 检查、填写、权限和条件字段。
- `outlines`：内置书签、编辑、层级和跳转。
- `navigation`：精确跳转、多级回退和证据定位。
- `content`：文字、图像、OCR 和页面结构。
- `evidence`：来源、修订、几何位置和引用校验。
- `retrieval`：关键词、语义搜索、索引、缓存和增量更新。

UI 和模型工具都调用这些领域服务，不直接修改 Native 或独立维护 PDF 状态。

## 7. 页面内容与引擎

页面统一转换为结构化内容：

```ts
interface PageContent {
  page: number
  revision: number
  blocks: ContentBlock[]
}
```

每个内容块保留来源、几何位置、revision、digest、置信度、提取器和 evidence reference。

引擎统一注册：

```ts
interface EngineProvider {
  id: string
  kind: 'ocr' | 'image-understanding' | 'embedding' | 'translation'
  capabilities: string[]
  configSchema: unknown
}
```

OCR 和图像理解保持为两个独立类别：

```text
OCR：图像 → 文字
图像理解：图像 + prompt → 结构化描述
```

默认实现也必须通过同一注册接口接入。以上接口是概念边界，实际实现保留 OCR、视觉、Embedding 和翻译各自的类型化能力，不强制所有引擎共用不透明的 `unknown` 工厂。插件卸载时注销当前实例、取消在途任务并移除可用候选；不能删除用户已保存的引擎选择。持久结果是否可复用由生产者身份、配置、输入摘要、提取语义版本和协议兼容策略决定。重新注册相同且可验证的引擎身份后，应允许复用已有结果。

## 8. 索引与检索

索引覆盖原生文字、OCR 文字、图像描述、embedding、页面结构和证据元数据。

索引必须支持：

- 磁盘持久化；
- 重启复用；
- 跨会话复用；
- 按页增量更新；
- 失败后继续；
- 取消；
- engine 配置隔离；
- 文档变更校验；
- 精确跳转和引文验证。

索引身份必须拆成不同层级：

- 文件摘要：用于外部变更、保存冲突和当前引用新鲜度；
- 页面内容摘要：用于 OCR、图像描述和文字产物复用；
- 表示摘要：用于分块和向量复用；
- Host 工作副本 revision：只用于授权、新鲜度和重新签发证据，不参与跨会话内容缓存键；
- runtime instance/worker generation：只用于运行时有效性，不参与持久缓存键；
- extraction schema / protocol version：只有在改变产物语义时才使对应产物失效。

批注、便签和其他不改变正文的工作副本操作不能使正文 OCR 或向量失效。只修改一页时，失效所有依赖该页内容的产物；如果共享字体、XObject、继承属性或其他依赖关系影响多页，则按依赖闭包失效。无法可靠计算某页身份时，只回退该页到源字节身份，不默认整份文件重建。

搜索结果必须返回 page、quote、source、revision、evidence ref、几何状态和是否需要视觉复核。

## 9. 模型工具

工具保持原子化，且与 UI 使用同一套领域入口。

- 当前文档和打开文档；
- 读取页面内容；
- 获取页面截图；
- 关键词和语义搜索；
- 精确跳转和多级回退；
- 创建、修改和删除批注；
- 创建、修改和删除便签；
- 读取和编辑书签；
- 表单检查和填写；
- 保存文档。

模型编辑直接进入工作副本，保存仍需要用户确认。工具输入和输出必须包含 revision、来源和证据校验，不能让模型直接操作内部 PDF 字段或坐标。

## 10. Client/UI

Client 只负责展示 Host 状态、触发领域命令、展示任务和错误、管理交互状态以及实现布局和动画。

Client 不负责 PDF 解析、索引有效性判断、表单写入或独立文档状态维护。Native 提供权威 PDF 几何；Client 可以在本地完成 viewport 变换、鼠标/触摸坐标换算、拖选、框选、缩放锚定和局部命中测试，避免每个 pointer move 经过 IPC。提交选区、批注或表单写入时，必须由 Host/Native 重新验证。

选择、输入中问题、弹层、滚动锚点、标签页历史和动画状态属于 Client 临时交互状态，不要求全部迁移到 Host；只有 PDF 文档业务事实和跨会话共享状态由 Host 提供。

逻辑上可以有多个受管理 Worker：前台渲染与后台扫描/索引必须隔离。协议统一不等于所有请求进入一个阻塞队列，需要定义队列上限、优先级、请求合并、背压、句柄租约、内存预算和取消语义。

需要统一 Reader、Toolbar、左右 Sidebar、批注浮层、便签、翻译、解释模式、表单、书签和任务面板的状态来源。

## 11. 测试体系

### 协议与 Native

- Native 协议契约测试；
- Fake Backend 和真实 PDFium Backend 双实现测试；
- Worker 重启、取消、超时和 malformed request；
- PDFium patch 应用和 manifest 校验；
- 表单、书签、批注、Unicode、加密和保存。

### Domain 与 Adapter

- 工作副本和 revision；
- 多会话共享和 UI 接管；
- 索引缓存、失败续跑和增量更新；
- 证据、几何和 source digest；
- 引擎注册、卸载和错误转换；
- DSH 工具与 Host 服务的一致性。

### 性能和恢复

- 相同机器、相同 PDF 建立滚动、跳转、拖选、缩放和索引基线；
- 记录帧延迟、长任务、各进程 CPU、峰值内存、IPC 次数和重复渲染次数；
- 测试前台渲染不被后台索引阻塞；
- 测试 Worker 崩溃、响应丢失、Host 重启和索引中断后的恢复；
- 测试取消排队任务与取消执行中任务的不同结果。

### 数据迁移和兼容

- 旧草稿、基线、索引库、阅读位置、设置和公开 SDK 都要有迁移表；
- 删除旧实现不等于删除旧数据读取能力；
- 为损坏记录、格式升级、备份、回滚和不可降级场景定义行为；
- 使用旧版本夹具验证升级后仍能打开、编辑、保存和恢复。

### Client 与跨平台

- Reader、缩放、滚动、侧栏和浮层；
- 翻译、OCR、解释模式和区域截图；
- 批注、便签、书签和表单；
- macOS Apple Silicon/Intel、Windows x64、Linux glibc x64/arm64；
- npm 安装、GUI 安装和系统 DSH 兼容性。

覆盖率口径必须明确：TypeScript、Native Worker 和可独立编译的项目代码纳入行覆盖率；链接进 PDFium 动态库的扩展和补丁当前不纳入 LLVM 行覆盖率，改由真实 Native 回归测试覆盖。若要纳入行覆盖率，必须另行增加 PDFium SDK 插桩、源码映射、采集和合并任务，不能通过缩小源码清单提高数字。覆盖率必须和契约测试、集成测试、E2E 一起作为完成条件，不能只用单元测试数字代替验收。

性能验收固定为：同一台机器、同一份基准 PDF、冷启动 3 次、暖缓存 5 次；滚动、拖选和缩放交互的 p95 帧时间目标为普通文档 ≤16.7ms、大文档 ≤33.3ms；后台索引期间前台 p95 相对基线回归不超过 10%；CPU 峰值、峰值内存、IPC 次数和重复渲染次数相对基线回归不超过 15%。P0 记录基线，若硬件导致绝对阈值不适用，则冻结相对阈值和测试环境。

## 12. 实施阶段

### P0：清点、基线和冻结协议

进入条件：仓库范围、目标平台、基准 PDF、现有测试命令和当前版本号已确定。P0 任务：清点当前调用链、现有命令和数据格式，建立功能/契约/数据格式清单；记录滚动、跳转、拖选、索引和保存基线；定义 Native 协议、错误格式、能力报告、文档句柄和文档引用模型；建立真实 Native 贯穿测试。P0 完成前不开始大规模搬迁。

### P1：抽离 NativePort 和命令映射

让 Node.js 所有 PDF 调用经过统一 NativePort；逐项迁移现有命令，保持行为不变，删除直接访问 PDFium 的路径。每迁移一项，必须有契约测试、真实 Worker 测试和调用方验收。

### P2：拆分 Worker 和 Backend

已完成：`native/worker/worker-runtime.{h,cpp}` 负责长度前缀 framing、请求关联、错误封装、Windows 二进制管道和进程循环；`native/backend/pdf-backend.h` 定义稳定的 `PdfBackend`；`native/backend/pdfium/pdfium-worker.cpp` 只保留 PDFium 文档状态与命令执行。CMake 和无 CMake 的构建路径都显式编译 runtime，真实 PDFium 测试覆盖 Worker/Backend 贯穿行为。

### P3：建立 PDFium Patch Queue

已完成：`native/pdfium/patches/patchset.json` 固定有序转换步骤和所有扩展源，`patchset.mjs` 生成摘要；SDK 写入 `DSH_PATCHSET`，Native 构建与发布 manifest 验证 PDFium source revision + patchset。升级仍必须在 clean checkout 上运行转换脚本；后续 upstream 接受某个变更时，删除对应步骤并重新冻结摘要。

### P4：统一 Host 领域层

已完成：统一文档引用、工作副本、保存、回退、加密、权限和生命周期；“打开 → 编辑 → 撤销 → 保存 → 重新打开”及 Worker 重启、响应丢失、加密权限边界均有回归覆盖。UI 与模型工具均通过 Host 领域入口。

### P5：重构页面内容和索引

已完成：接入原生文字、OCR、图像描述和 embedding，支持结构化页面内容、增量索引、磁盘持久化、跨会话复用、失败续跑和证据链；批注保存不会触发正文重建，页面变更只失效其依赖闭包，引擎重新注册可复用持久产物。

### P6：重构模型工具

已完成：工具按文档、阅读、检索/证据、批注、书签、表单、导航/保存和图像能力拆分，统一输入输出、revision、来源和错误语义，删除重复工具和旧提示词路径。

### P7：迁移 Client/UI

已完成：Reader、Sidebar、Toolbar、表单、书签、翻译和解释模式只从 Host 获取 PDF 文档业务事实；UI 仅保留选择、输入、滚动锚点、弹层和动画等临时状态。跨层边界、窄宽度布局、浮层、选择和恢复场景均有测试。

### P8：构建、发布和文档

已完成本地交付链：平台原生包、npm 包出口、GUI/CLI 安装、GitHub Actions、examples、README、SPEC、架构和测试文档已同步；发布前检查会验证包出口、原生依赖、平台清单、声明图和路径扫描。远程 Actions 仍需在仓库提交后由 GitHub 给出最终结果。

### 12.1 每个阶段的统一执行模板

按照 AGENTS.md 的要求，每个阶段开始前都必须写清楚：

1. **场景与验收**：谁发起、经过哪些状态、成功和失败分别看到什么；
2. **归属**：功能属于哪个领域模块，复用哪些已有能力；
3. **所有者与边界**：Client、Host、Native、持久化和会话分别拥有哪部分状态；
4. **结构**：要扩展哪些现有文件，哪些职责确实需要拆分；
5. **验证**：针对性测试、跨边界测试、交互验收、性能或资源检查；
6. **删除项**：迁移完成后删除哪些旧入口、旧导出、旧测试和旧文档引用。

每个阶段必须有明确的进入条件和退出条件：

| 阶段 | 进入条件 | 退出条件 |
| --- | --- | --- |
| P0 | 仓库范围、目标平台、基准 PDF 和测试环境可定位 | 当前实现清单、性能基线、命令映射、状态边界、迁移数据表和真实 Native 烟测通过 |
| P1 | 协议类型和错误模型已冻结 | 所有现有命令经过 NativePort，旧直连路径删除 |
| P2 | P1 真实贯穿测试通过 | Worker/Backend 分离，前台与后台任务隔离测试通过（已完成） |
| P3 | PDFium revision 和工具链固定 | clean checkout 可重复构建，patch 冲突会失败 |
| P4 | Native 事务结果可验证 | 打开→编辑→撤销→保存→重开闭环和故障恢复通过 |
| P5 | 页面内容身份模型冻结 | 单页增量、跨会话复用、失败续跑和证据链通过 |
| P6 | 领域服务接口稳定 | UI 和模型工具共用入口，重复工具和旧提示词删除 |
| P7 | Host 状态流稳定 | 关键交互无性能回归，Client 不再维护独立 PDF 业务状态 |
| P8 | 所有跨平台包可构建 | CI、npm、GUI/CLI 安装和系统 DSH 验收通过 |

### 12.2 复杂模块的拆分边界

不按文件大小机械拆分，而按职责拆分：

- Retrieval：任务调度、索引检查点、查询执行、共享源租约；
- Working Copy：文档登记/引用、草稿事务、恢复、保存；
- Reader：渲染、视口、交互模式、浮层组合；
- Model Tools：读取、检索、批注、书签、表单、导航的工具装配；
- Native PDF service：协议转换和 Backend 调度，不承载 Host 状态。

拆分后每个模块仍然保持单一入口。只被一个模块使用的私有辅助逻辑不提升为公共抽象。

## 13. 风险控制

- 协议先冻结，再迁移调用方，避免 Node 和 Native 同时变化。
- 先完成行为等价，再进行性能优化。
- 性能不是最后才验证的事项；P0 建立基线，之后每个跨边界阶段都复测。
- 不在第一阶段支持多个 PDF Backend；只预留接口。
- 不引入动态 Native 插件加载，避免 ABI 和安全问题。
- 每个阶段完成针对性测试后再进入下一阶段。
- 旧路径迁移完成后立即删除，避免长期双实现。

### 13.1 Patch Queue 构建身份

除 upstream revision 和 patch hash 外，还必须记录：有序 patch 清单、扩展源码摘要、构建参数、目标平台和固定工具链/依赖来源。干净检出、严格顺序应用；偏移或冲突立即失败；不得修改开发者原始 checkout。每个 patch 必须记录目的、关联测试和升级处理方式。

## 14. 完成标准

- Node.js 不依赖 PDFium 内部类型；
- Native 可以替换 PDFium 实现而不改 Node.js；
- PDFium 使用固定版本和 patch queue 构建；
- 所有 PDF 能力通过统一 Native 协议；
- UI 和模型工具共享 Host 领域服务；
- 工作副本、索引、证据、权限和生命周期统一；
- `pdf-lib` 和旧 PDF 实现完全删除；
- 单元、Native、集成、E2E 和跨平台测试通过；
- 打开/编辑/撤销/保存/重新打开闭环和故障恢复测试通过；
- 性能基线没有引入前台交互回归；
- 旧数据、加密文档、Worker 重启和引擎重新注册验收通过；
- GitHub Actions 和 npm 发布流程通过；
- README、examples、SPEC 与实际代码一致。

## 15. 计划审查后的实施门槛

以下内容完成前，不进入 P1 生产代码迁移：

1. 完成功能、契约、数据格式和性能基线清单；
2. 完成现有命令到新协议的映射表；
3. 明确 Host 工作副本与 Native 可变文档的事务模型；
4. 明确文件摘要、页面摘要、表示摘要和 revision 的身份关系；
5. 明确 Worker 隔离、队列、背压、内存预算和取消语义；
6. 明确旧数据迁移、损坏恢复和回滚策略；
7. 让 CI 在每个阶段都能执行真实 Native 贯穿测试。

这些门槛是 AGENTS.md 中“先定义边界和验收，再实现；架构迁移必须删除旧路径并补齐测试”的具体化，不是额外的长期抽象目标。

### 15.1 P0 必须形成的决策记录

P0 不能只产出讨论文档，还必须形成可供实现直接引用的记录：

- `docs/native-command-map.md`：现有命令 → 新 schema → 调用方 → 测试；
- `docs/document-state-matrix.md`：文档、会话、草稿、索引、权限和证据的所有者；
- `docs/transaction-state-machine.md`：打开、修改、物化、持久化、发布、恢复和失败状态；
- `docs/index-identity.md`：文件、页面、表示、引擎和提取语义身份；
- `docs/migration-matrix.md`：旧数据格式、升级、损坏、备份和回滚；
- `docs/performance-baseline.md`：固定语料、机器、次数、指标和阈值；
- `schemas/native/*.json`：机器可读协议 schema；
- `tests/contracts/fixtures/*.json`：TS/C++ 共享的 golden contract fixtures。

协议同步采用“JSON Schema + TypeScript 类型生成 + TS/C++ golden fixtures + CI schema diff”方案。目录相邻不是同步机制；任何 schema 变化都必须同时更新生成类型、Native 解析/验证和契约 fixtures。

### 15.2 会话、权限和加密边界

| 状态/数据 | 同一资源会话 | 跨会话 |
| --- | --- | --- |
| 未保存工作副本 | UI 和模型共享 | 默认不共享 |
| 正文 OCR/向量/图像描述 | 可读取 | 仅在内容身份和权限允许时共享 |
| 阅读位置、滚动锚点、解释问题 | 会话内共享 | 不共享 |
| evidence handle | 会话内有效 | 重新签发，不直接复用 |
| 用户授权、密码、受保护草稿 | 内存和授权边界内 | 不共享 |

加密文档必须保留密码和受保护草稿的内存生命周期、签名只读限制、批注权限、原安全设置和保存批准范围。统一入口不能扩大权限，也不能把跨会话索引复用误认为跨会话草稿共享。

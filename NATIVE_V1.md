# 原生 PDF 架构第一版

本分支以 `50733d8e95c97c828b2f7282e86c999f127ca966` 为上游基线，在现有虚拟阅读、标注、草稿和保存功能上接入真实 PDFium 服务。它实现原生阅读的完整纵向链路；原生对象编辑、Agent 工具注册和全量性能发布门禁仍属于后续阶段。

## 运行

```sh
npm ci
npm run native:build
npm run build
npm run check
```

原生构建需要 C++17 编译器，Windows 还需要 CMake 和 Visual Studio C++ 工具。脚本固定 PDFium `156.0.8076.0`、nlohmann/json `3.12.0`，校验下载文件 SHA-256，将 helper、动态库、版本清单和许可复制到 `dist/native/`。原生 SDK 和生成的二进制不提交进 Git。

默认 `readerEngine=auto`：存在匹配的 helper 时使用原生模式；缺少 helper、加密、签名、表单或原生打开失败时回退。设置页也可选择 `pdfjs` 或 `native`，重新打开 PDF 后生效。强制原生模式遇到不兼容文件会明确报错，避免把兼容模式数据记作原生结果。Host 可通过 `DSH_PDF_NATIVE_HELPER` 指定可信 helper 路径；Client 请求不能指定可执行文件或文件系统路径。

## 已实现的功能

| 功能 | 第一版实现 | 验证方式 |
| --- | --- | --- |
| 阅读、缩放、旋转、适合页面 | PDFium 栅格化，512 设备像素分块，1 像素边缘留白 | 真实浏览器首屏、滚动、4 倍缩放；裁剪和旋转像素检查 |
| 长文档虚拟化、跳页、返回历史 | 数字页布局和二分查找；只挂载视口附近或被选择的页面 | 1000 页组件样本；真实 Harness Web 128 页远距离跳转 |
| 文字选择、跨页选择 | PDFium 文字位置接入原有文字层；保留选择相关页 | 真实 Web 拖动选择、跨页选择和滚动后选择保留 |
| 搜索 | 按页提取文字；每 8 页公布已有结果；渲染任务优先于文本任务 | 原生文字提取和浏览器文字层验证；原有搜索拼接测试 |
| URI、内部目的地、命名导航 | PDFium 读取 URI/目的地；Host 保留 Next/Prev/First/Last 命名动作 | URI/目的地测试，原有链接命中和协议过滤测试 |
| 高亮、下划线、删除线、便笺 | 复用权威操作日志、投影、撤销重做和 pdf-lib 写入器 | 原有操作、草稿恢复、失败保存、签名只读测试；原生 v2 保存测试 |
| 修改既有标注的显示 | 相交分块重新请求无标注图像，局部补绘；沿用 SVG 投影 | 既有补绘几何测试；分块一致性测试 |
| 截图和 OCR 图像准备 | 同一原生页接口按分块组合指定区域，继续使用原有截图/OCR 管线 | 原生截图适配及已有 OCR 映射测试；OCR 引擎注册方式保持一致 |
| 翻译、字典 | 保留既有扩展接口 | 既有扩展和服务测试 |
| 页面对象检查 | 按页分页读取对象类型/边界，每次最多 100 项，明确只读 | 原生对象检查测试 |

## 数据和进程链路

1. Host 通过原有 session、文件策略和本地文件适配器读取 PDF，拥有草稿、版本、操作日志和保存权限。
2. `pdf.dispatch.v2` 首次返回页几何和文档元数据；连续 revision 的操作只返回标注 upsert/remove 和状态。revision 不连续时重发完整元数据。请求携带 mutationId，丢失响应后的单次重试不重复应用操作。
3. 原生模式向 Client 传递文档 ID 和基线摘要，不传整份 PDF。兼容模式通过 Connection 的 multipart `bytes` 附件传 PDF，保留旧 `pdf.dispatch` 的 Base64 协议供旧 Client 使用。
4. `pdf.native` 与现有 RPC 一样注册到 Connection，并解析 session 的真实 Agent。每次请求再次核对工作副本归属、基线 SHA-256、页码和尺寸。Client 的 ID 不能绕过文件或 session 授权。
5. Host 将已授权字节发送给独立 C++ helper。协议是两个小端 uint32 长度、JSON 元数据和二进制数据；PDFium 只在一个命令循环中执行。JSON 回包限 2 MiB、像素回包限 8 MiB，队列限 256 项。
6. 原生页面缓存最多 16 页/文档，文档句柄最多 16 个、输入字节合计最多 128 MiB。Host PNG 缓存 32 MiB，Client 解码位图缓存 24 MiB、文字缓存 4 MiB；移出窗口的画布和被淘汰的 ImageBitmap 会释放。
7. 取消排队任务时立即移除；同步渲染已经开始时丢弃其回复，收到该帧后才继续下一项。超时结束 helper；后续请求重新握手并从 Host 基线字节恢复。保存改变基线摘要后重新打开原生文档。

保存与授权仍在 Host。helper 通过进程隔离避免在 Host V8 中直接运行 PDFium；本版没有新增操作系统级沙箱。

## 性能假设和测量

效率提升来自减少长文档 DOM、去除原生模式的 Client PDF 解析和全文预热、只渲染可见区域、避免整页高倍画布，以及标注增量和二进制传输。它们并不保证每个小文档或首屏场景都更快；helper 启动、PNG 编码和分块 RPC 也有成本。

```sh
npm run bench:browser -- --engine legacy --repeats 3 --out bench-results/v1-legacy
npm run bench:browser -- --engine native --repeats 3 --out bench-results/v1-native
npm run bench:compare -- --before bench-results/v1-legacy/runs.jsonl --after bench-results/v1-native/runs.jsonl --allow-backend-switch --out bench-results/v1-comparison.md
```

`legacy` 使用上游原有 PDF.js 阅读与实验预热；`pdfjs` 使用 v2 二进制协议的兼容阅读器；`native` 强制原生引擎。对照必须使用同一冻结测试代码、语料摘要、浏览器版本、DPR、视口、缓存状态和场景。场景包含 12 页文档、1000 页文档、1000 标注文档的首屏、8000 CSS 像素滚动和 4 倍缩放。

| 指标 | 定义或范围 |
| --- | --- |
| firstUsefulProxyMs | 可见页面面积至少 90% 有已完成位图的首个帧代理时间 |
| targetQualityProxyMs | 可见面积至少 99% 达到目标采样质量，再经过一帧；保留旧缩放位图不算达标 |
| scrollSettleProxyMs | 指定滚动结束后恢复目标质量的时间 |
| blankAreaTimeRatio / maxBlankAreaRatio | 可见 PDF 页面区域的空白比例；未挂载页面也计入分母 |
| rafIntervalP95Ms / longTaskTotalMs | RAF 帧间隔和浏览器主线程长任务；不等同于 GPU FPS |
| mountedPageWrappers / domNodes | 已挂载页容器与整个测试页面的 DOM 数量 |
| canvasPixelBytesEstimate | canvas 宽×高×4 的像素估计；不是浏览器 RSS |
| nativeTileCacheBytes / nativeDocumentBytes | 场景结束前的 Host PNG 缓存和 helper 输入字节记账；不是进程 RSS |
| rpcRequestCount / rpcResponseBytes | 同一场景上下文中的 RPC 次数和响应体字节，包括初始化；不是 TCP 总流量 |
| CPU / Host RSS | 既有 `npm run bench` 的 Host 组件测量；不涵盖浏览器和原生子进程的总 CPU/RSS |

浏览器总 RSS 当前标记为 unavailable。不得用画布像素或缓存记账代替总进程内存。3 次 smoke 只能用于初步对照；发布级结论需要至少 20 次重复、真实扫描/CJK/复杂字体/透明图形语料、所有进程资源测量和图像质量复核。原始 JSONL 保留失败行、环境、树摘要、协议摘要和分离的 Host/Client 时钟。

本次 54 个场景的原始数据与改进、退步结果见 [smoke 对照记录](docs/benchmarks/native-v1-20260930/README.md)。Linux x64 的完整检查通过 79 项测试；真实 Harness Web 的原生与缺少 helper 的兼容回退两条路径各通过 2 项测试，涵盖选区、便笺保存、区域截图像素、缩放、远页跳转和跨页选区保留。跨平台 CI 尚需远端实际执行。

## 当前边界

- Host 首次完整 pdf-lib 检查、权威工作副本字节和既有草稿格式仍保留。此版没有消除所有 Host 全文解析或保证所有已打开文件总内存恒定。
- PDFium 文本使用兼容字体生成透明选择层；CJK、竖排、RTL 和复杂字体仍需要扩充真实语料验收。遇到选择不准确可切换兼容引擎。
- 表单和签名回退；加密 PDF 沿用已有只读规则及密码限制。未知标注的 AP 保留仍由原有写入器负责。
- 页面内容对象移动、文本替换、图片/矢量对象写入、稳定对象 ID 和 Agent 工具发布尚未实现；对象检查不能作为这些编辑能力的承诺。
- 本地验证以 Linux x64 为准。CI 增加 Linux、macOS、Windows 原生构建和测试，但跨平台通过情况应以实际 CI 结果为准。

这份文档与 `PERFORMANCE.md` 一起构成第一版的功能、指标和发布验收依据；完整后续设计继续按原架构计划推进。

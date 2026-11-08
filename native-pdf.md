# 原生 PDF 实现

本文说明 PDFium worker 的构建、分发、协议与运行限制。整体数据归属见[架构文档](docs/architecture.md)，功能与工具契约见[功能规范](spec.md)和[模型工具契约](docs/agent-tools.md)，测量方法与结果见[性能证据](performance.md)。

## 分发与加载

主包通过精确版本的 optional dependencies 选择 `@dylanl1/dsh-plugin-pdf-native-<target>`。支持 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64` 和 `win32-x64`，Linux 使用 glibc。普通安装不执行原生下载或编译脚本；安装方式见 [README](README.zh.md)。

每个平台包的 `bin/` 将以下文件作为一组分发，动态库须保持与 helper 的相对位置：

- `dsh-pdf-native`（Windows 为 `.exe`）；
- `libpdfium.dylib`、`libpdfium.so` 或 `pdfium.dll`；
- `manifest.json`、PDFium 与 JSON 依赖许可证。

`src/entrypoints/native-host.ts` 从主包安装位置解析平台包，核对包版本、平台、协议、helper/动态库 SHA-256 及执行权限。源码 checkout 可使用 `dist/native/`；发布主包不包含该回退路径所需的原生源码清单。文件缺失或损坏时明确失败，不切换阅读引擎。

Host 管理员可用 `DSH_PDF_NATIVE_HELPER` 指向可信 helper；这是显式覆盖正常分发校验的部署入口，启动时仍须通过协议握手。Client 不能指定可执行文件。

## 源码构建

```sh
npm ci
npm run native:build
npm run build
```

`native/dependencies.json` 固定 PDFium `156.0.8076.0` 与 nlohmann/json `3.12.0` 及下载摘要。`scripts/build-native.mjs` 校验 SDK/JSON，编译 C++17 helper，并将可执行文件、动态库、清单和许可证放入 `dist/native/`。生成文件与 SDK 不提交 Git。

构建优先使用 CMake；macOS/Linux 可在未安装 CMake 时直接使用 `clang++`/`g++`。Windows 需要 CMake 与 Visual Studio C++ 工具。自备依赖可通过 `DSH_PDFIUM_ROOT` 和 `DSH_PDF_JSON_DIR` 指定，版本及 JSON 摘要仍校验。macOS 动态库路径为 `@loader_path`，Linux 为 `$ORIGIN`。

## Host 与 worker 边界

`src/adapters/host/pdfium/pdf-service.ts` 从已授权工作副本取得源字节，拥有 native handle、缓存和渲染租约。`native-worker.ts` 使用 DSH `subprocess` 服务解析并启动进程，运行目录为 helper 所在目录。Host 持有文件与会话权限，worker 仅接收 PDF 字节和不透明文档 ID，不接收 Host 文件路径或暴露 native 指针。

PDFium 的所有调用在 C++ 的单一命令循环中执行；输入字节与文档 handle 同寿命。页面、form environment 和文档按依赖顺序释放。进程隔离用于控制故障与资源寿命，不等于另加操作系统级沙箱。

Host 的打开/读取租约保证 mutable native document ID 不在一次读取中被另一个基线替换。阅读请求校验所属会话、工作副本、基线字节摘要、页号和参数；保存或 worker 重启后按新基线/代次重新打开，不复用旧渲染结果。

## 帧协议

协议定义位于 `src/engine/framing.ts` 与 `native/pdfium-worker.cpp`。stdin/stdout 都使用二进制帧：

```text
uint32le JSON字节数 | uint32le 二进制字节数 | UTF-8 JSON | 二进制载荷
```

每条请求带唯一 `requestId` 和 `command`。成功回复为 `{requestId, ok: true, value}`，失败回复为 `{requestId, ok: false, error: {code, message}}`；Host 校验关联与长度。`open` 的载荷是 PDF 字节；`render` 回复的载荷是 RGBA 像素，其余命令返回 JSON。stdout 只能写协议，stderr 被 Host 排空且不无界保存。

| 命令 | 职责 |
| --- | --- |
| `hello` | 返回协议版本、引擎和 PDFium build；Host 必须匹配 |
| `open` / `close` | 从字节创建/释放文档；返回页数、表单类型和签名数量 |
| `text` | 原生文字项、样式、逐字位置及 Unicode 映射质量 |
| `outline` / `destination` | 读取书签树和命名目的地 |
| `links` | 读取页链接及目的地 |
| `inspect` | 分页只读检查页面对象类型和边界，每批最多 100 项 |
| `render` | 按页、方向、完整栅格尺寸和 tile 区域绘制，独立控制标注及表单外观 |

协议当前为 `1`。JSON 上限 2 MiB，请求二进制上限 256 MiB，回复二进制上限 8 MiB。native 页号从 0 开始，Host 外部页号从 1 开始。tile 最大 1026×1026，包含边缘余量；正常 Reader 使用 512 设备像素分块，图像组合由 Host 控制。

## 调度、取消与资源

`NativeWorker` 一次只发送一个命令，按优先级排列等待队列；tile 高于普通文本/元数据读取。等待队列最多 256 项、256 MiB 载荷，单命令默认超时 30 秒。

取消尚未运行的任务会立即移出队列；已开始的 PDFium 同步调用不能在调用内中断，Host 拒收其结果，收到对应帧后才继续下一项。超时、崩溃或协议错误拒绝在途任务并终止受管理进程范围；替代 worker 必须等待旧范围退出，再握手恢复。插件卸载同时取消可执行文件解析，防止迟到启动，并等待进程退出。

Host 最多保留 16 个 native 文档 handle、128 MiB 输入字节，按 LRU 淘汰；worker 自身另有 32 个文档的防御上限，每文档缓存最多 16 个 PDFium 页面。Host PNG 缓存默认 32 MiB，修复文字缓存 8 MiB，均为有界缓存；这些额度不代表所有进程的总内存上限。

RGBA 在 Host 编码为 PNG，通过有界 RPC 返回 Client。Client 管理解码位图和画布，移出渲染窗口或缓存淘汰时释放。原生租约、PNG 编码和后续 OCR 分属不同阶段，识别过程不占用 native 读取租约。

## 原生能力范围

- PDFium 读取/绘制普通页面、原生文字、链接、目的地、书签和 AcroForm 原有外观；不在 worker 中编辑或保存 PDF。表单、标注和目录写入由上层共享工作副本及 pdf-lib 完成。
- 表单环境仅用于绘制，不运行 PDF JavaScript、网络动作或 PDFium 表单输入事件。XFA 不支持；签名文档只读，签名数量不代表已验证签名真伪。
- PDFium 能解锁的加密 PDF 只读打开，文本提取遵守 PDF 权限。密码由 Host 在阅读视图存续期间保留在内存中，原文件保持加密，阅读器不生成解密副本。
- 截图/OCR 可关闭原生标注或 widget 外观；图像生成不能据此推断 OCR/图像理解后端可用。未保存的编辑投影也不是 native 源基线的一部分。
- 文字提取区分合法换行断字标记与 Unicode 映射故障。Host 可用随包本地 OCR 修复异常文字层，结果标记为派生/近似文字；不会改写原 PDF，也不能冒充精确原生字形证据。复杂字体、RTL、竖排等版面的结果仍取决于实际提取质量。
- 页面对象检查为只读；对象移动、正文替换、图片/矢量写入和稳定页面对象 ID 不在当前协议中。

协议、进程生命周期和原生集成测试由 `npm run check` 收集；真实原生用例需先构建 helper，`DSH_PDF_REQUIRE_NATIVE_TESTS=1` 可禁止缺少 helper 时跳过。覆盖率入口见 [测试文档](docs/testing.md)。历史原生 smoke 数据保留在 [benchmark 目录](docs/benchmarks/native-v1-20260930/README.md)，不作为当前实现的性能结论。

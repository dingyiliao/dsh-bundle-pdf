# DSH PDF 阅读与标注插件

独立的 DeepSeek Harness 插件，安装包名为 `@local/dsh-pdf`。源码和依赖放在本目录，通过 DSH 的插件、右侧文档栏、设置页和 Connection 扩展接口接入。

当前实现对接 **DSH 0.2.0-rc.1** 的公开接口，已在本地 Web 和 Desktop profile 安装并确认 Host 激活。构建、类型检查和代表 PDF 的解析与只读兼容检查已通过；界面交互仍需结合实际宿主验证。DSH 接口仍可能随版本变化，需要与实际使用的宿主版本一起确认。

## 功能范围

| 优先级 | 当前范围 |
| --- | --- |
| P0 · PDF 阅读和编辑 | 右侧文档栏阅读、缩放和旋转视图、原有文字选择、文字搜索；识别和编辑原生高亮、下划线、删除线、便笺批注；撤销、重做、手动保存和另存为 |
| P0 · 阅读跳转 | PDF 内部链接跳转、页码定位、搜索结果和批注定位；按后进先出顺序返回跳转前的位置，恢复 PDF 坐标、缩放、旋转和适配方式 |
| P0 · 扫描件与设置 | 整页或框选区域 OCR；可取消和超时；NoneOCR / LocalOCR；DSH 设置页中的 PDF 配置卡片 |
| 当前阅读扩展 · 选区翻译 | 浮动工具条翻译选中文字；独立翻译引擎，复用 DSH 模型，默认中文；结果仅显示在 PDF 面板 |
| P1 · PDF 书签 | 后续实现 |
| P3 · 模型操作 PDF | 后续实现，包括模型工具、文字或图像发送至会话、会话中的解读和翻译 |

此处的“PDF 编辑”指**标注编辑**，不包括修改正文、重新排版、页面增删、涂黑脱敏或编辑表单。选择文字、框选区域和 OCR 已用于阅读与标注；点击“翻译”时才向所选翻译引擎提交选中文字，不附带会话上下文，也不把请求或结果写入会话历史。

详细产品约定见 [SPEC.md](./SPEC.md)。

## 安装到本地 Web profile

准备 Node.js `^22.19.0` 或 `>=24.0.0`、`npm`、`pnpm`，以及与上述版本匹配的 `dsh` 命令。DSH 的 `plugin` 子命令使用 `pnpm` 管理 profile 内的插件依赖。

### 1. 在插件目录安装依赖并构建

```powershell
git clone https://github.com/dingyiliao/dsh-bundle-pdf.git
Set-Location .\dsh-bundle-pdf
npm ci
```

`prepare` 会执行构建，生成 `dist/`。如果安装时禁用了生命周期脚本，或之后修改了源码，执行：

```powershell
npm run build
```

构建包含宿主入口、客户端入口、OCR SDK 与类型声明、PDF.js worker 和字体资源，以及 OCR worker、WASM 和中英文语言数据。构建不需要读取旁边的 DSH 源码 checkout。

### 2. 创建带 Web 界面的 profile

以下命令创建新的 `pdf-reader-demo` profile，并输出组合配置，不启动服务：

```powershell
dsh --profile pdf-reader-demo --from-default-profile web --dump-config
```

`--from-default-profile` 只能用于尚不存在的自定义 profile。已有 Web profile 可以直接用于下一步，并替换命令中的名称。仅运行 `dsh plugin add` 自动创建的 profile 以 base 为基础，因此新 profile 应先从 `web` 模板创建。

### 3. 链接插件目录

在本插件目录中执行：

```powershell
dsh plugin --profile pdf-reader-demo add .
dsh --profile pdf-reader-demo --dump-config
```

检查输出中包含 `id: pdf-reader`、`name: '@local/dsh-pdf'`。本包的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，DSH 会将其加入该 profile。安装的是本地 checkout 的链接，保留本目录和其 `node_modules`；更换目录后应重新安装链接。

### 4. 从要阅读文件的工作目录启动

```powershell
dsh --profile pdf-reader-demo --no-open
```

打开命令输出的地址，在会话文件中打开 PDF。已经运行的实例需要重启以加载插件及新构建产物。PDF 必须位于当前会话允许访问的本地文件路径中；保存还需要当前会话允许写入该路径。

这些步骤依据 DSH 的插件发布文档和 CLI 行为参考整理；本项目尚未执行实际安装验收。它们不需要修改 DSH 源码。

### 移除

```powershell
dsh plugin --profile pdf-reader-demo remove @local/dsh-pdf
```

该命令移除 profile 中的插件依赖及组合层，不删除本插件 checkout。

## 使用方式

### 默认 PDF 打开方式

插件使用 `documentPreviews.register()` 注册 `.pdf`，优先级为 `extension`，通过 `sidebar.right.tab.document` 提供阅读界面。启用后参与 DSH 的默认 PDF 渲染器选择，优先于内置基础 PDF 渲染器；这不是操作系统的 PDF 文件关联。多个第三方插件同时处理 `.pdf` 时，最终选择仍遵循 DSH 的渲染器规则。

### 标注与保存

- 默认直接选择文字；选中文字后，选区旁显示浮动工具条，可复制、高亮、添加下划线、删除线或便笺。点击工具条不会丢失已捕获的选区；通过“工具 → 便笺”也可在页面上放置批注。
- 新增高亮会立即预览，编辑提交失败时移除预览并显示错误。
- 直接点击页面上的原生标注即可选中，浮动工具栏提供颜色修改、删除和批注入口；Delete 删除选中标注，Escape 取消选中。点击页面或查看器空白、查看器外部会隐藏选区和标注工具条、关闭未提交的便笺编辑。拖动选字和双击选字仍用于文字选择。
- 原有的受支持原生标注也会出现在标注列表中，可以修改颜色、批注内容或删除。创建与修改时间按本地时区显示。
- 标注与搜索面板作为浮层打开，不改变页面宽度和当前适配比例，可以通过面板右上角关闭。
- 页面、标注及搜索面板采用浮动滚动条：滚动、悬停或拖动时显示，停止滚动且未悬停时约 1.1 秒后隐藏。滚动条不占用页面宽度。
- PDF 链接悬停只显示手形光标，不覆盖交互框；可直接拖选链接文字。单击稍作延迟后跳转，双击选词会取消待执行的跳转。
- 编辑会显示未保存状态，并进入插件工作副本；点击“保存”才写入源 PDF，“另存为”写入指定副本。
- 点击“丢弃全部修改”立即恢复到上次成功保存或首次打开的基线，清空撤销、重做及草稿，不再弹确认框；不依赖源文件仍存在，也不改写源文件。
- 切换当前会话时关闭旧会话的 PDF 标签，并直接丢弃其未保存修改和草稿。清理等待打开中的请求返回，新的打开请求等待清理完成，避免迟到请求恢复已丢弃的修改。设置面板的显示/隐藏不被当作切换会话。尚未挂载的恢复标签通过宿主公开 inventory 处理；旧会话 Sidebar 未挂载时保留关闭任务，在下次挂载时关闭。
- 同一会话中手动关闭 PDF、断线或重启仍可恢复草稿。草稿包含原始 PDF 数据和编辑记录，由 DSH 的存储服务保存在宿主上；会话切换和显式丢弃会删除相应草稿。
- 源文件发生变化时会报告冲突，保留工作副本，提供另存副本或重新加载源文件的选择。

数字签名 PDF 为只读。允许直接打开的加密 PDF 使用 PDF.js 只读兼容方式加载，可阅读、搜索、跳转和查看原有标注；当前不支持编辑或保存加密 PDF。需要输入密码的文件会显示明确提示，交互式解锁属于后续范围。锁定、只读或无法安全编辑的原生标注会显示原因。扫描图像或页面内容中已被压平的高亮不是可编辑的 PDF 标注，无法恢复成原来的高亮对象。

### 扫描件、图像页和 OCR

所有页面先按 PDF 的实际画面渲染，包括扫描图像、普通文字和嵌入图片。原有文字层直接用于选择和搜索。通过“工具 → 区域截图”在单页内拖出矩形，完成后自动恢复文字选择；Escape 或取消按钮可退出截图。预览可以复制图片、下载 PNG 或识别区域文字；整页识别通过“工具 → 识别本页”执行。

截图直接渲染 PDF 工作副本的选定区域，保留页面图像、原生标注和当前显示旋转，不包含界面控件；清晰度独立于 Sidebar 缩放，上限为 2 倍和 1600 万像素。此操作只在本地生成图像，不发送到会话或模型。

默认引擎是 **NoneOCR**：不执行识别，仍可阅读页面图像。在 DSH 设置页的 **PDF** 卡片中选择 **LocalOCR** 并保存设置后，使用本地 Tesseract.js 识别。随包提供 `eng` 和 `chi_sim`，默认语言配置为 `eng+chi_sim`；也可单独使用其中一种。

LocalOCR 的 worker、WASM、语言数据全部随插件提供，经 `/api/pdf-assets/` 的同源资源路由加载，运行时不使用公共 CDN、不向 OCR 厂商发送页面。首次安装依赖需要取得软件包；资源准备完成后，本地识别本身不依赖外部服务。

当前 LocalOCR 资源地址只接受同源 **HTTP / HTTPS**。Web profile 是当前实现的目标；Desktop 等使用自定义 URL scheme 的承载方式尚未确认兼容，不能据此视为已支持离线 OCR。

识别产生临时文字层，保留引擎、覆盖区域和置信度信息。结果可以选择和搜索，并用于定位标注；**OCR 本身不会把文字层写回 PDF**。尚未识别的扫描区域不在文字搜索范围内，识别质量取决于页面质量和语言配置。

### 跳转返回

成功跳转后，“返回”恢复上一次位置。连续跳转按栈回退；失败、取消及无实际位移的跳转不新增记录。普通滚动不建立跳转记录。历史属于当前 PDF 标签；重新加载不同内容后会清除旧内容的历史。

### 选区翻译与原生查询

选择文字后点击浮动工具条的“翻译”，右侧面板显示原文、页码和译文。默认采用 PDF 所属会话当前选择的 DSH 模型（尚未选择时采用 DSH 默认模型），复用宿主已有凭据，源语言自动检测、目标语言为中文。可以切换目标语言后再次翻译、取消、重试或复制译文；翻译不修改 PDF。

单次选区最多 8192 个 UTF-16 字符，默认超时 30 秒，模型输出上限为 4096 tokens，统一输出上限为 32768 个字符。输入不会被静默截断；模型达到输出限制时保留部分译文并显示未完成提示。切换文档、关闭面板或改变翻译配置会取消旧请求。

“查询”功能要求 **macOS 选区旁的原生词典浮窗**。当前 DSH 0.2.0-rc.1 没有向插件开放主窗口 `showDefinitionForSelection()` 对应接口，因此此功能尚未接通：Windows/Linux 不显示按钮，macOS 显示禁用按钮及原因。插件仅提供 `pdfDictionary` 能力注册接口，等待真实宿主桥接；不会改用词典应用或联网查询来冒充浮窗。

### 设置

PDF 配置卡片提供 OCR 引擎、识别语言、超时、翻译引擎、原文/目标语言、翻译超时、默认标注颜色、跳转历史容量和 PDF 大小上限。设置修改需要手动保存；“恢复默认”移除当前层的覆盖值，重新采用宿主配置组合的默认值，保存后生效。

默认超时为 120 秒，跳转历史容量为 100，文件大小上限为 64 MiB。大文件、复杂页面和 OCR 会增加内存占用。

阅读标签复用 PDF.js worker，保存未改变页面字节时保留现有页面；连续编辑只处理本次操作，撤销/重做使用有容量限制的页面状态缓存。每次编辑仍需序列化 PDF，首次打开复杂文档和扫描件仍可能耗时。

## 文件访问与保存边界

目前仅支持 DSH 的**本地文件系统**实现；远程文件系统、虚拟文件系统和其他文件后端会被明确拒绝。读取和写入都绑定资源地址携带的会话，不使用当前选中的其他会话代替授权。路径会经过本地文件系统、会话访问策略和符号链接检查。

保存使用同路径串行队列、源文件摘要比较、同目录临时文件和最终替换。另存到新路径默认不覆盖已有文件，覆盖需要在界面中选择。文件冲突不会通过静默覆盖来解决。

**并发边界：**插件内部可以串行保存并检查源版本，但普通文件系统没有跨任意外部进程的通用 compare-and-swap。其他程序如果恰好在最后一次摘要检查与替换之间写入，仍存在竞态；保存后校验也无法消除这一窗口。该实现不宣称对外部编辑器提供跨进程事务保证。

## 性能

性能改动与剩余瓶颈见 [PERFORMANCE.md](./PERFORMANCE.md)。尚未测量实际加速比例；普通标注编辑仍包含一次完整 PDF 解析、序列化及阅读器换文档。

## 扩展 OCR 引擎

OCR 接口与具体实现分离，公开 SDK 入口为 `@local/dsh-pdf/ocr`，类型声明随构建生成。客户端插件通过 `ctx.pdfOcr` 注册自己的引擎；卸载时注销会取消该引擎正在执行的请求并清理对应缓存。

下面是一个**接入示意**，其中 `providerEngine` 由扩展插件实现：

```ts
import type { OcrEngine, OcrRegistry } from '@local/dsh-pdf/ocr'
import { providerEngine } from './provider-engine.js'

export const name = 'my-pdf-ocr-provider'
export const inject = ['pdfOcr']

interface Context {
  pdfOcr: OcrRegistry
  effect(callback: () => () => void, label?: string): unknown
}

export function apply(ctx: Context) {
  const engine: OcrEngine = providerEngine
  ctx.effect(() => ctx.pdfOcr.register(engine), 'register PDF OCR provider')
}
```

引擎实现 `descriptor`、可选的 `availability(configuration)` 和 `recognize(request, configuration)`：

- 输入是已编码的页面或区域图像、像素尺寸、语言、取消信号、进度回调及超时设置。
- 输出包含文字、块/行/词、实际覆盖区域和警告。坐标统一为输入图像左上角原点的像素坐标；阅读器负责转换为 PDF 坐标。
- 置信度保留引擎自身的量纲和解释，不把不同厂商的分数当成统一概率。
- Registry 将引擎、实例、配置版本、源文件版本和区域纳入结果来源及缓存键。切换设置后，已开始的请求使用开始时的配置快照。
- 远程供应商应在自己的宿主插件中管理凭证和网络调用，通过 DSH Connection 提供客户端适配器；不要将密钥放入客户端 bundle 或 PDF 设置字段。

当前提供通用设置字段和注册机制，尚未内置任何厂商 OCR，也未提供自动生成厂商专用配置表单的功能。适配器应先完成加载，再打开 PDF 设置页选择对应引擎。

## 扩展翻译引擎与词典能力

翻译 SDK 入口为 `@local/dsh-pdf/translation`。翻译功能只调用 `TranslationRegistry` / `TranslationService`，引擎实现 `descriptor`、可选的 `availability(configuration)` 与 `translate(request, configuration)`，返回纯文本、完整/部分状态和警告；引擎负责具体厂商协议，并转发取消信号。内置 `NoneTranslation` 和 DSH 模型实现，OCR 与翻译的引擎和设置互相独立。

Host 扩展插件通过 `ctx.pdfTranslation.register(engine)` 注册后端，并在自己的配置中管理端点与凭据。请求经认证的 `/api/pdf.translation` 路由进入 Host；Client 使用通用代理，不引用厂商 SDK，也不接收模型密钥。安装新 Host 引擎后重新加载 PDF 插件，使客户端取得新的引擎目录。客户端本地实现也可注册到 Client 的 `pdfTranslation`，SDK 不要求某个特定供应商。

词典 SDK 为 `@local/dsh-pdf/native-dictionary`，Client 扩展可以通过 `ctx.pdfDictionary.register({ platform: 'darwin', lookupSelection })` 注册真实原生桥接。注册并通过 macOS 平台检测后按钮才可用；接口不会自行获得 Electron 主窗口权限。当前没有随包提供的可用桥接实现。

## 目录与构建产物

```text
src/host/          会话绑定文件访问、工作副本、保存和本地资源路由
src/client/        Sidebar 阅读器、设置卡片、PDF.js runtime
src/core/          PDF 原生标注及文档处理
src/navigation/    跳转历史
src/ocr/           OCR 接口、Registry、NoneOCR、LocalOCR
src/translation/   独立翻译接口、Registry、请求服务、NoneTranslation
scripts/build.mjs  独立打包与本地资源收集
dist/index.js      DSH Host 插件入口
dist/client.js     DSH ModuleLoader 客户端入口
dist/ocr.js        浏览器 OCR SDK
dist/types/ocr/    OCR SDK 类型声明
dist/translation.js 翻译 SDK（附类型声明）
dist/native-dictionary.js macOS 原生词典能力 SDK（附类型声明）
dist/assets/ocr/   本地 OCR worker、WASM 和中英文语言数据
```

客户端复用宿主的 React 和 DSH 服务，宿主包通过 peer dependency 解析，避免在独立插件中建立另一套宿主服务实例。PDF.js 的 worker、CMap、标准字体和 WASM 在构建时内联进客户端资源；OCR 资源使用固定清单路由并校验长度和 SHA-256。

## 许可证

本插件代码采用 [MIT License](./LICENSE)。PDF.js、pdf-lib、Tesseract.js 及语言数据等依赖保留各自许可证；构建会生成 `dist/THIRD_PARTY_NOTICES.md`，列出随包分发的第三方许可文本。

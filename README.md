# DSH PDF 阅读与标注插件

独立的 DeepSeek Harness 插件，安装包名为 `@local/dsh-pdf`。源码和依赖放在本目录，通过 DSH 的插件、右侧文档栏、设置页和 Connection 扩展接口接入。

当前实现对接 **DSH 0.2.0-rc.1** 的公开接口。构建和 TypeScript 类型检查已通过；尚未在运行中的 DSH 实例中安装、打开真实 PDF 或完成端到端验收。DSH 接口仍可能随版本变化，需要与实际使用的宿主版本一起确认。

## 功能范围

| 优先级 | 当前范围 |
| --- | --- |
| P0 · PDF 阅读和编辑 | 右侧文档栏阅读、缩放和旋转视图、原有文字选择、文字搜索；识别和编辑原生高亮、下划线、删除线、便笺批注；撤销、重做、手动保存和另存为 |
| P0 · 阅读跳转 | PDF 内部链接跳转、页码定位、搜索结果和批注定位；按后进先出顺序返回跳转前的位置，恢复 PDF 坐标、缩放、旋转和适配方式 |
| P0 · 扫描件与设置 | 整页或框选区域 OCR；可取消和超时；NoneOCR / LocalOCR；DSH 设置页中的 PDF 配置卡片 |
| P1 · PDF 书签 | 后续实现 |
| P3 · 模型操作 PDF | 后续实现，包括模型工具、文字或图像发送至会话、解读和翻译 |

此处的“PDF 编辑”指**标注编辑**，不包括修改正文、重新排版、页面增删、涂黑脱敏或编辑表单。选择文字、框选区域和 OCR 已用于阅读与标注；当前没有发送到模型的操作。

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

- 在文字层上选择文字后添加高亮、下划线或删除线；使用便笺工具在页面上放置批注。
- 原有的受支持原生标注会出现在标注列表中，可以修改颜色、批注内容或删除。
- 编辑会显示未保存状态，并进入插件工作副本；点击“保存”才写入源 PDF，“另存为”写入指定副本。
- 工作副本保存草稿，关闭后再次打开时可恢复尚未写入源 PDF 的修改。草稿包含原始 PDF 数据和编辑记录，由 DSH 的存储服务保存在宿主上。
- 源文件发生变化时会报告冲突，保留工作副本，提供另存副本或重新加载源文件的选择。

数字签名 PDF 为只读；加密 PDF 当前不支持打开。锁定、只读或无法安全编辑的原生标注会显示原因。扫描图像或页面内容中已被压平的高亮不是可编辑的 PDF 标注，无法恢复成原来的高亮对象。

### 扫描件、图像页和 OCR

所有页面先按 PDF 的实际画面渲染，包括扫描图像、普通文字和嵌入图片。原有文字层直接用于选择和搜索。需要识别扫描件或图片内文字时，可手动识别整页，或框选区域后识别。

默认引擎是 **NoneOCR**：不执行识别，仍可阅读页面图像。在 DSH 设置页的 **PDF** 卡片中选择 **LocalOCR** 并保存设置后，使用本地 Tesseract.js 识别。随包提供 `eng` 和 `chi_sim`，默认语言配置为 `eng+chi_sim`；也可单独使用其中一种。

LocalOCR 的 worker、WASM、语言数据全部随插件提供，经 `/api/pdf-assets/` 的同源资源路由加载，运行时不使用公共 CDN、不向 OCR 厂商发送页面。首次安装依赖需要取得软件包；资源准备完成后，本地识别本身不依赖外部服务。

当前 LocalOCR 资源地址只接受同源 **HTTP / HTTPS**。Web profile 是当前实现的目标；Desktop 等使用自定义 URL scheme 的承载方式尚未确认兼容，不能据此视为已支持离线 OCR。

识别产生临时文字层，保留引擎、覆盖区域和置信度信息。结果可以选择和搜索，并用于定位标注；**OCR 本身不会把文字层写回 PDF**。尚未识别的扫描区域不在文字搜索范围内，识别质量取决于页面质量和语言配置。

### 跳转返回

成功跳转后，“返回”恢复上一次位置。连续跳转按栈回退；失败、取消及无实际位移的跳转不新增记录。普通滚动不建立跳转记录。历史属于当前 PDF 标签；重新加载不同内容后会清除旧内容的历史。

### 设置

PDF 配置卡片提供 OCR 引擎、识别语言、超时、默认标注颜色、跳转历史容量和 PDF 大小上限。设置修改需要手动保存；“恢复默认”移除当前层的覆盖值，重新采用宿主配置组合的默认值，保存后生效。

默认超时为 120 秒，跳转历史容量为 100，文件大小上限为 64 MiB。大文件、复杂页面和 OCR 会增加内存占用。

## 文件访问与保存边界

目前仅支持 DSH 的**本地文件系统**实现；远程文件系统、虚拟文件系统和其他文件后端会被明确拒绝。读取和写入都绑定资源地址携带的会话，不使用当前选中的其他会话代替授权。路径会经过本地文件系统、会话访问策略和符号链接检查。

保存使用同路径串行队列、源文件摘要比较、同目录临时文件和最终替换。另存到新路径默认不覆盖已有文件，覆盖需要在界面中选择。文件冲突不会通过静默覆盖来解决。

**并发边界：**插件内部可以串行保存并检查源版本，但普通文件系统没有跨任意外部进程的通用 compare-and-swap。其他程序如果恰好在最后一次摘要检查与替换之间写入，仍存在竞态；保存后校验也无法消除这一窗口。该实现不宣称对外部编辑器提供跨进程事务保证。

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

## 目录与构建产物

```text
src/host/          会话绑定文件访问、工作副本、保存和本地资源路由
src/client/        Sidebar 阅读器、设置卡片、PDF.js runtime
src/core/          PDF 原生标注及文档处理
src/navigation/    跳转历史
src/ocr/           OCR 接口、Registry、NoneOCR、LocalOCR
scripts/build.mjs  独立打包与本地资源收集
dist/index.js      DSH Host 插件入口
dist/client.js     DSH ModuleLoader 客户端入口
dist/ocr.js        浏览器 OCR SDK
dist/types/ocr/    OCR SDK 类型声明
dist/assets/ocr/   本地 OCR worker、WASM 和中英文语言数据
```

客户端复用宿主的 React 和 DSH 服务，宿主包通过 peer dependency 解析，避免在独立插件中建立另一套宿主服务实例。PDF.js 的 worker、CMap、标准字体和 WASM 在构建时内联进客户端资源；OCR 资源使用固定清单路由并校验长度和 SHA-256。

## 许可证

本插件代码采用 [MIT License](./LICENSE)。PDF.js、pdf-lib、Tesseract.js 及语言数据等依赖保留各自许可证；构建会生成 `dist/THIRD_PARTY_NOTICES.md`，列出随包分发的第三方许可文本。

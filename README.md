# DSH PDF 阅读与标注插件

独立的 DeepSeek Harness 插件，安装包名为 `@local/dsh-pdf`。源码和依赖放在本目录，通过 DSH 的插件、右侧文档栏、设置页和 Connection 扩展接口接入。

公开仓库：[dingyiliao/dsh-bundle-pdf](https://github.com/dingyiliao/dsh-bundle-pdf)。

包配置声明支持 **DSH 0.2.0-rc.1**、**0.2.1-alpha.1** 与 **0.2.1-alpha.2** 的公开接口。阅读仅使用原生 PDFium 引擎，通过独立 C++ worker、认证二进制附件、视口分块和标注增量提供阅读能力；标注、草稿、保存与扩展接口继续复用。第一版实现、平台要求、验证方法和后续边界见 [NATIVE_V1.md](./NATIVE_V1.md)。DSH 接口仍可能随版本变化，需要与实际宿主版本一起确认。

普通安装使用与操作系统、CPU 架构匹配的预构建包，不需要本机 C++ 编译器。从源码开发时运行 `npm ci && npm run native:build && npm run build`；Windows 源码构建还需要 CMake 和 Visual Studio C++ 工具。没有匹配平台的 PDFium helper 时，阅读器不会切换到其他引擎。

## 功能范围

| 优先级 | 当前范围 |
| --- | --- |
| P0 · PDF 阅读和编辑 | 右侧文档栏阅读、缩放、原有文字选择和文字搜索；识别和编辑原生高亮、下划线、删除线、便笺批注；撤销、重做、手动保存、另存为、一键丢弃；切换会话关闭 PDF 并直接丢弃草稿 |
| P0 · 阅读跳转 | PDF 内部链接跳转、页码定位、搜索结果和批注定位；按后进先出顺序返回跳转前的位置，恢复 PDF 坐标、缩放和适配方式 |
| P0 · 扫描件与设置 | 可阅读扫描页并框选截图；OCR 开关暂时固定关闭且不可操作，识别入口隐藏；DSH 设置页提供 PDF 配置卡片 |
| 原生第一版 · 长文档阅读 | 数字页布局只挂载视口附近及选择相关页；按需提取文字、以 512 设备像素分块渲染，并限制位图/文字/PNG 缓存；不进行后台全文预热 |
| 当前阅读扩展 · 选区翻译 | 浮动工具条翻译选中文字；独立翻译引擎，复用 DSH 模型，默认中文；结果仅显示在 PDF 面板 |
| P1 · 页面与书签 | 右侧栏提供按需绘制的页面缩略图、PDF 内置目录和插件个人书签；个人书签可新建、改名、删除，跨会话重开恢复 |
| P3 · 模型操作 PDF | 只读第一步：模型工具取得当前可见 PDF/页、按页分段读取原文、限定范围搜索；选区/图像发送至会话、OCR、标注写入和保存仍待实现 |

此处的“PDF 编辑”指**标注编辑**，不包括修改正文、重新排版、页面增删、涂黑脱敏或编辑表单。当前可以选择 PDF 原有文字、框选区域；OCR 暂不开放。点击“翻译”时才向所选翻译引擎提交选中文字，不附带会话上下文，也不把请求或结果写入会话历史。

在同一会话打开 PDF 后，可以直接向模型提问“解释当前 PDF 的这一页”或“结合上下文翻译这一页的某段”。`pdf_current` 返回当前可见文档的句柄和物理页；`pdf_read_page` 按 2～8000 个 UTF-16 字符分段读取并给出续读偏移，`pdf_search` 在最多十页的窗口内精确搜索并给出游标。工具只读取当前会话有权访问的工作副本，不改变阅读位置或 PDF，也不自动上传整份文件。扫描页和图表目前没有模型侧 OCR/图像读取：若无可提取文字，工具会明确返回 `no_text`，模型不得声称已理解其视觉内容。当前可见页由客户端短期同步，不会写入会话日志；工具实际读取的页码、版本和原文会成为工具结果。选区级会话解读与会话翻译仍待实现。

详细产品约定、已实现/受限/后续状态见 [SPEC.md](./SPEC.md) 第 0 节。当前物理页码已实现，PDF 自带显示页标签尚未接入。可直接打开的加密 PDF 和数字签名 PDF 为只读。编辑与保存的物化边界见 [PERFORMANCE.md](./PERFORMANCE.md)。

### 阅读布局（已实现，待交互验收）

顶部工具栏保留返回、缩放和文档操作；页码输入、总页数与上一页/下一页位于右侧阅读辅助栏底部（折叠时保留紧凑页码导航）。手动显示旋转已移除，页面仍按 PDF 自带方向显示。底部重复的文件路径栏已移除，重新加载位于工具菜单中。

左边为 PDF 内容区，在该区域按住 **Ctrl 滚动鼠标滚轮**即可围绕鼠标所在内容进行 **10%～500%** 缩放，当前比例同步到顶部控件；普通滚轮仍用于滚动。右边为可折叠、可调宽的阅读辅助栏，最右侧保留竖向入口；页面、书签、翻译、标注、便笺和搜索在同一区域切换，切换视图不改变 PDF 可用宽度。展开、折叠或调整辅助栏宽度后，适应宽度依据左侧区域重新计算，并保持当前页内阅读位置。

辅助栏默认展开标注视图，参考宽度 320 像素，窄窗口按可用空间收窄；折叠后保留 44 像素入口栏。可拖动分隔线调宽，也可聚焦后用左右方向键和 Home/End 调整；功能入口支持上下方向键和 Home/End 切换。

便笺仅筛选已有 `Text` 原生标注，与标注列表共用编辑和保存逻辑；选区翻译自动进入翻译视图。切换视图或折叠辅助栏保留译文、搜索结果，并继续进行中的翻译。书签视图分开显示 PDF 内置目录和个人书签。个人书签保存在插件数据中，不写入 PDF；源文件变化时提示核对位置，原页面消失时禁用跳转。

### 长文档页面布局

仍从 DSH 文件栏打开 PDF：`documentPreviews.register()` 和 `sidebar.right.tab.document` 的公开入口没有改变。Reader 使用 `WindowedPages`：为每页计算数字几何，用一个容器保持整份文档的滚动高度，只在视口及其前后各约一个视口范围内挂载页面；被选中的标注和拖动中的页面可暂时保留挂载。跨页拖选时，经过的页面及捕获后的选区页保留文字层和定位信息，因此大范围选区的文字 DOM 用量随选中页数增长。跳转到远页时先按数字几何定位，再挂载目标页并绘制画布和文字层。普通离屏页卸载后会释放画布与文字 DOM。

阅读器不进行全页预热，也不生成后台低分辨率预览。文字搜索首次按页读取文字和坐标，后续查询利用有界文字缓存和紧凑页面摘要跳过确定无匹配的页面；当前扫描图像不在文字搜索范围内。原生 helper 按需取得页面文字与可见分块。

页面几何数组和缩放后的布局计算仍随总页数增长，挂载的页面 DOM 与画布主要随可见窗口及暂时保留的选区页增长。打开与保存整份 PDF 的成本仍在；当前实现变更后的首屏、滚动和峰值内存需要重新测量。详见 [PERFORMANCE.md](./PERFORMANCE.md)。

## 预构建包

GitHub Actions 在每次 PR 或指定分支推送时为 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`win32-x64` 分别构建和测试，并在该次运行的 Artifacts 中保存五个 `.tgz` 安装包。**一个平台包是一个归档，不是一个裸可执行文件**：其中包含共同的 JavaScript 插件、该平台的 PDFium helper、相邻的动态库、校验清单和许可证。当前工作流不自动创建 GitHub Release；安装前需要从 Actions 页面下载对应 Artifact 并解压出 `.tgz`。

把 `.tgz` 的绝对路径传给 `dsh plugin --profile <profile> add <absolute-path-to-tgz>`。DSH 会加载同一 bundle 中的两个 Host 插件：`pdf-native` 异步校验原生文件并提供 `pdfNative` 服务，`pdf-reader` 等待该服务可用后启动。预构建包不运行安装时构建脚本；从 Git URL 安装源码不会获得预构建原生文件，因此不能替代平台包。

## 从源码安装到本地 Web profile

准备 Node.js `^22.19.0` 或 `>=24.0.0`、`npm`、`pnpm`，以及与上述版本匹配的 `dsh` 命令。DSH 的 `plugin` 子命令使用 `pnpm` 管理 profile 内的插件依赖。

### 1. 在插件目录安装依赖并构建

```powershell
git clone https://github.com/dingyiliao/dsh-bundle-pdf.git
Set-Location .\dsh-bundle-pdf
npm ci
npm run native:build
npm run build
```

已有 checkout 时，也在其目录执行上述构建命令。

安装依赖不会自动构建产物；修改源码后需要明确重新执行：

```powershell
npm run native:build
npm run build
```

构建包含 PDFium helper、宿主入口、客户端入口、OCR SDK 与类型声明，以及 OCR worker、WASM 和中英文语言数据。构建不需要读取旁边的 DSH 源码 checkout。

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

检查输出中包含 `id: pdf-native`、`name: '@local/dsh-pdf/native'` 和 `id: pdf-reader`、`name: '@local/dsh-pdf'`。本包的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，DSH 会将其加入该 profile。安装的是本地 checkout 的链接，保留本目录和其 `node_modules`；更换目录后应重新安装链接。

### 4. 从要阅读文件的工作目录启动

```powershell
dsh --profile pdf-reader-demo --no-open
```

打开命令输出的地址，在会话文件中打开 PDF。已经运行的实例需要重启以加载插件及新构建产物。PDF 必须位于当前会话允许访问的本地文件路径中；保存还需要当前会话允许写入该路径。

这些步骤依据 DSH 的插件发布文档和 CLI 行为整理。本地开发 profile 已链接插件并确认 Host 激活；仍需按使用环境完成界面及文件保存验收。它们不需要修改 DSH 源码。

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
- 标注、便笺、翻译和搜索集中在右侧阅读辅助栏，切换功能视图不改变 PDF 内容区宽度；辅助栏可以折叠和调宽。
- 页面、标注及搜索面板采用浮动滚动条：滚动、悬停或拖动时显示，停止滚动且未悬停时约 1.1 秒后隐藏。滚动条不占用页面宽度。
- PDF 链接悬停只显示手形光标，不覆盖交互框；可直接拖选链接文字。单击稍作延迟后跳转，双击选词会取消待执行的跳转。
- 编辑会显示未保存状态，并进入插件工作副本。新增、修改、删除、撤销和重做只更新标注投影与操作记录；点击“保存”时才将有效操作写成新 PDF，“另存为”写入指定副本。
- 点击“丢弃全部修改”立即恢复到上次成功保存或首次打开的基线，清空撤销、重做及草稿，不再弹确认框；不依赖源文件仍存在，也不改写源文件。
- 切换当前会话时关闭旧会话的 PDF 标签，并直接丢弃其未保存修改和草稿。清理等待打开中的请求返回，新的打开请求等待清理完成，避免迟到请求恢复已丢弃的修改。设置面板的显示/隐藏不被当作切换会话。尚未挂载的恢复标签通过宿主公开 inventory 处理；旧会话 Sidebar 未挂载时保留关闭任务，在下次挂载时关闭。
- 同一会话中手动关闭 PDF、断线或重启仍可恢复草稿。草稿将基线 PDF 和编辑操作分开存入 DSH 的宿主存储：首次编辑保存基线，后续只更新操作记录；会话切换和显式丢弃会删除相应草稿。
- 源文件发生变化时会报告冲突，保留工作副本，提供另存副本或重新加载源文件的选择。

数字签名 PDF 为只读。当前不支持加密 PDF，也不提供交互式密码解锁；打开时会显示明确提示。锁定、只读或无法安全编辑的原生标注会显示原因。扫描图像或页面内容中已被压平的高亮不是可编辑的 PDF 标注，无法恢复成原来的高亮对象。

### 扫描件、图像页和 OCR

可见页面按 PDF 的实际画面渲染，包括扫描图像、普通文字和嵌入图片；远页通过数字几何保留滚动位置，进入窗口后才绘制正式画布。PDF 原有文字层在相应页面挂载后可用于选择和搜索。通过“工具 → 区域截图”在单页内拖出矩形，完成后自动恢复文字选择；Escape 或取消按钮可退出截图。截图预览可以复制图片、下载 PNG。

截图渲染 PDF 基线的选定区域，并合成未保存的标注操作；保留页面图像与可见标注，不包含界面控件。清晰度独立于 Sidebar 缩放，上限为 2 倍和 1600 万像素。此操作只在本地生成图像，不发送到会话或模型。原生标注被删除或改色时，预览会修补其旧外观；修补区域若与未知或自定义外观重叠，该交叠部分可能无法完整保留。

当前设置页保留一个关闭且禁用的 **OCR** 开关；整页和区域识别入口均隐藏。底层仍保留 NoneOCR / LocalOCR、Tesseract.js 和 `eng`、`chi_sim` 语言数据，以便后续继续实现与验收；即使旧配置选择了 LocalOCR，当前客户端也强制使用 NoneOCR。

预留的 LocalOCR worker、WASM、语言数据全部随插件提供，经 `/api/pdf-assets/` 的同源资源路由加载，不使用公共 CDN。首次安装依赖需要取得软件包；功能重新开放前不执行识别。

当前 LocalOCR 资源地址只接受同源 **HTTP / HTTPS**。Web profile 是当前实现的目标；Desktop 等使用自定义 URL scheme 的承载方式尚未确认兼容，不能据此视为已支持离线 OCR。

保留的实现会将识别结果映射为临时文字层，供选择、搜索和标注定位；**OCR 本身不会把文字层写回 PDF**。当前开关关闭，扫描区域不参与文字搜索。

### 跳转返回

成功跳转后，“返回”恢复上一次位置。连续跳转按栈回退；失败、取消及无实际位移的跳转不新增记录。普通滚动不建立跳转记录。历史属于当前 PDF 标签；重新加载不同内容后会清除旧内容的历史。

### 选区翻译

选择文字后点击浮动工具条的“翻译”，进入右侧阅读辅助栏的翻译视图，显示原文、页码和译文。默认采用 PDF 所属会话当前选择的 DSH 模型（尚未选择时采用 DSH 默认模型），复用宿主已有凭据，源语言自动检测、目标语言为中文。可以切换目标语言后再次翻译、取消、重试或复制译文；翻译不修改 PDF。

单次选区最多 8192 个 UTF-16 字符，默认超时 30 秒，模型输出上限为 4096 tokens，统一输出上限为 32768 个字符。输入不会被静默截断；模型达到输出限制时保留部分译文并显示未完成提示。切换文档、明确关闭译文或改变翻译配置会取消旧请求；切换右栏视图或折叠辅助栏不会取消请求或清空译文。

### 设置

PDF 配置卡片显示关闭且禁用的 OCR 开关，不显示识别引擎、语言和超时设置。卡片可配置翻译引擎、翻译超时和跳转历史容量；目标语言在翻译视图中选择，PDF 大小上限不占用设置卡片。翻译时自动检测原文语言；标注颜色在创建或编辑单条标注时选择，不设全局默认颜色。设置修改需要手动保存；“恢复默认”移除当前层的覆盖值，重新采用宿主配置组合的默认值，保存后生效。

预留的 OCR 默认超时为 120 秒；翻译默认超时为 30 秒，跳转历史容量为 100。PDF 文件大小上限默认 64 MiB，可通过当前 profile 的 `cordis.patch.yml` 覆盖 `pdf-reader` 条目的 `maxFileBytes`（单位为字节，配置范围 1～256 MiB）：

```yaml
- id: pdf-reader
  config:
    maxFileBytes: 100663296 # 96 MiB
```

后应用的 patch 会替换该条目的整个 `config`，不是合并字段；如果已经覆盖了其他配置项，需要在同一 `config` 中重述。当前原生阅读器还有独立的 128 MiB 工作集上限；调高 `maxFileBytes` 不会取消它。大文件和复杂页面会增加内存占用。

阅读由原生 PDFium helper 完成，Client 不加载整份 PDF 或后台全页预热。未保存标注操作保持 PDF 基线字节不变，连续编辑更新标注投影，撤销重放有效操作。保存时才序列化 PDF；首次编辑持久化基线、首次打开复杂文档和扫描件仍可能耗时。

## 文件访问与保存边界

目前仅支持 DSH 的**本地文件系统**实现；远程文件系统、虚拟文件系统和其他文件后端会被明确拒绝。读取和写入都绑定资源地址携带的会话，不使用当前选中的其他会话代替授权。路径会经过本地文件系统、会话访问策略和符号链接检查。

保存使用同路径串行队列、源文件摘要比较、同目录临时文件和最终替换。另存到新路径默认不覆盖已有文件，覆盖需要在界面中选择。文件冲突不会通过静默覆盖来解决。

**并发边界：**插件内部可以串行保存并检查源版本，但普通文件系统没有跨任意外部进程的通用 compare-and-swap。其他程序如果恰好在最后一次摘要检查与替换之间写入，仍存在竞态；保存后校验也无法消除这一窗口。该实现不宣称对外部编辑器提供跨进程事务保证。

## 性能

性能改动与剩余瓶颈见 [PERFORMANCE.md](./PERFORMANCE.md)。普通标注编辑不再完整解析、序列化或重开 PDF；首次草稿基线写入和保存仍处理整份文件。当前页面窗口实现尚无重新测量的加速比例或峰值内存结果。[原有基准数据](docs/benchmarks/native-v1-20260930/README.md)保留为旧协议和预热路径的历史记录，不代表当前实现。

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

## 扩展翻译引擎

翻译 SDK 入口为 `@local/dsh-pdf/translation`。翻译功能只调用 `TranslationRegistry` / `TranslationService`，引擎实现 `descriptor`、可选的 `availability(configuration)` 与 `translate(request, configuration)`，返回纯文本、完整/部分状态和警告；引擎负责具体厂商协议，并转发取消信号。默认使用内置的 DSH 模型引擎，可切换到已安装的其他翻译引擎；设置中不提供关闭翻译的选项。OCR 与翻译的引擎和设置互相独立。

Host 扩展插件通过 `ctx.pdfTranslation.register(engine)` 注册后端，并在自己的配置中管理端点与凭据。请求经认证的 `/api/pdf.translation` 路由进入 Host；Client 使用通用代理，不引用厂商 SDK，也不接收模型密钥。安装新 Host 引擎后重新加载 PDF 插件，使客户端取得新的引擎目录。客户端本地实现也可注册到 Client 的 `pdfTranslation`，SDK 不要求某个特定供应商。

## 目录与构建产物

```text
src/host/          会话绑定文件访问、工作副本、保存和本地资源路由
src/client/        Sidebar 阅读器与设置卡片
src/client/native/ 数字页面布局、窗口挂载及原生阅读实现
src/core/          PDF 原生标注及文档处理
src/navigation/    跳转历史
src/ocr/           OCR 接口、Registry、NoneOCR、LocalOCR
src/translation/   独立翻译接口、Registry、请求服务
scripts/build.mjs  独立打包与本地资源收集
dist/index.js      DSH Host 插件入口
dist/client.js     DSH ModuleLoader 客户端入口
dist/ocr.js        浏览器 OCR SDK
dist/types/ocr/    OCR SDK 类型声明
dist/translation.js 翻译 SDK（附类型声明）
dist/assets/ocr/   本地 OCR worker、WASM 和中英文语言数据
```

客户端复用宿主的 React 和 DSH 服务，宿主包通过 peer dependency 解析，避免在独立插件中建立另一套宿主服务实例。OCR 资源使用固定清单路由并校验长度和 SHA-256；PDFium helper 与动态库位于 `dist/native/`。

## 测试

提交前运行 `npm run check` 和 `npm run test:web`。前者执行源码与测试类型检查、构建、单元测试和构建入口 Loader 冒烟，包含 1001 页数字布局单测；后者使用相邻的 `../deepseek-harness` checkout 中的 Web 测试脚手架，以临时 Web profile 经 Loader 加载构建产物，再由 Chromium 打开、标注和保存真实 PDF，并检查 Mac 样式下的文字选区、模拟触控板捏合，以及 128 页文档的远页跳转和活跃页面数量。预期 ARIA 输出位于 `tests/expected/web-pdf/`。先在相邻 DSH 仓库执行 `pnpm install` 和 `pnpm run build`，并在本仓库执行 `npm ci`。缺少相邻 checkout 时 Web 测试会明确报错。Windows 上若 Playwright 缓存没有 Chromium，测试优先使用已安装的 Google Chrome，缺少 Chrome 时回退到 Microsoft Edge。模拟事件检查不能代替 macOS Electron 真机验收或性能基准。

## 许可证

本插件代码采用 [MIT License](./LICENSE)。PDFium、pdf-lib、Tesseract.js 及语言数据等依赖保留各自许可证；构建会生成 `dist/THIRD_PARTY_NOTICES.md`，列出随包分发的第三方许可文本。

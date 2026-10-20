# DSH PDF 阅读器

## 背景

我经常用 PDF 阅读论文和资料，但常见阅读器总会缺少一些顺手的功能，例如连续跳转多次后逐级返回原来的阅读位置；具备模型解读、翻译等功能的产品又往往需要额外付费。于是我借助 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 写了这个自用插件，把 PDF 阅读、标注和 DSH 已有的模型能力放在同一个工作区，按自己的需求继续迭代。

## 使用方法

1. 在 [GitHub Actions](https://github.com/dingyiliao/dsh-bundle-pdf/actions) 选择 `main` 分支上与要安装的源码提交 SHA 一致、且构建成功的 native 工作流。从该运行的 **Artifacts** 下载与你的系统和 CPU 匹配的 `dsh-pdf-npm-package-<target>`：`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64` 或 `win32-x64`。先解压下载的 ZIP，取出其中的 `.tgz`。目前这些包不在 Releases 中。
2. 将 `.tgz` 安装到要使用的 DSH profile，安装后重启 DSH。例如，已有 Web profile 可以运行：

   ```sh
   dsh plugin --profile web add /absolute/path/to/package.tgz
   dsh web
   ```

   Desktop 用户需先启动一次应用以初始化 `desktop` profile，然后完全退出应用；通过 Desktop 菜单“管理 dsh 命令…”安装其自带的 CLI，再运行 `dsh plugin --profile desktop add /absolute/path/to/package.tgz`，最后重新打开应用。普通 npm 版 `dsh` 命令不能管理 Desktop profile。
3. 在 DSH 的文件栏打开有权访问的本地 PDF。阅读器提供页码与目录跳转、逐级返回、个人书签、文字搜索、标注和选区翻译。解释模式可收集带问题的文字选段或单页框选区域，并作为一轮提词发送到所属会话。文字选段由 Host 重新提取并签发会话限定的证据引用；框选区域发送时通过已鉴权的 `pdf.image` `prepare-reference` 重新校验会话、文档、源文件、附件和摘要，直接图片使用 Host 返回的字节，而不是浏览器暂存的截图。模型还可以在后台打开 PDF 工作副本、读页、搜索、列书签、查询副本状态、定位原文、组装有界上下文，以及按需获取页图像或 OCR 文字；这些读取不会自动打开侧栏标签。`pdf_render_page` 默认仍只向当前视觉模型返回页图；显式指定 `mode: configured-backend` 才使用 profile 选择的图像理解后端，其中 OCR 和辅助视觉路线只返回标注来源与局限的派生文字，不向当前会话返回图片。模型写入需要先用 `pdf_annotate` 预演，再由用户在 DSH 中明确批准提交到可撤销草稿；`pdf_save` 另行请求批准后才覆盖保存原文件。模型主动控制侧栏导航尚未实现。

翻译、解释以及首版 OCR 默认使用当前会话模型与 DSH 已配置的凭据，本插件不提供免费模型。框选解释默认要求当前会话模型明确支持图像输入；也可显式改用 `ocr-text`（只提取文字）或 `auxiliary-vision`（由另一视觉模型描述图像）。辅助路线会额外请求所配置的模型，可能产生费用；当前会话只接收派生描述，不接收原始截图，描述可能遗漏或误读细节。阅读器可按需识别整页或截图区域；内置 SessionLLM OCR 后端也需要视觉模型，仅返回可复制的转写文字，不生成可精确选中或标注的 PDF 文字层。加密 PDF 暂不支持。其他边界见 [SPEC.md](./SPEC.md)；[package.json](./package.json) 的 `peerDependencies` 列出声明兼容的 DSH 版本，当前 CI 使用 `0.2.0-rc.2` 依赖验证。

从源码开发时，在本仓库目录执行 `npm ci && npm run native:build && npm run build`，再用 `dsh plugin --profile web add .` 链接本地目录。直接通过 Git URL 安装源码不会得到原生构建产物。

## 架构

```mermaid
flowchart LR
  C["DSH Web / Desktop Client<br/>PDF 阅读、标注、解释模式"] -->|DSH Connection| H["pdf-reader Host<br/>文件、草稿、书签、保存、PDF 工具"]
  C -->|认证的区域图像请求| I["image-understanding Host<br/>可替换的图像处理后端"]
  I -->|当前视觉模型可用性| M["DSH 会话模型"]
  I -->|图像描述请求| A["可配置的辅助视觉模型"]
  I -->|OCR 文字路线| O
  C -->|一轮图文或派生文字提词| M
  N["pdf-native Host<br/>校验平台产物"] -->|pdfNative 服务| H
  O["image-ocr Host<br/>OCR 服务与可替换后端"] -->|ocr 服务| H
  H -->|stdio IPC| W["独立 PDFium worker<br/>渲染与文字提取"]
```

同一个 bundle 通过 [cordis.patch.yml](./cordis.patch.yml) 装入四个 Host 插件。`pdf-reader` 使用 `pdf-native`，并可调用独立的 `ocr` 服务；`image-understanding` 为解释模式的框选图像及模型工具显式请求提供同一后端选择。默认 `session-vision` 路线检查当前会话模型后发送原图；`ocr-text` 只返回带来源与局限说明的识别文字；`auxiliary-vision` 把截图交给显式指定的第二个视觉模型，再将其描述作为派生文字送入当前会话。三条路线不自动互相降级。其他 Host 插件仍可注册自己的 OCR 或图像理解后端，对应的类型契约由 `@local/dsh-pdf/ocr-host` 和 `@local/dsh-pdf/image-host` 导出。图像理解后端通过 profile patch 中 `pdf-image-understanding` 的配置选择；目前没有设置卡片。Client 经 DSH 的认证连接访问 Host，而不是直接调用原生库。Host 负责会话范围内的文件访问、批注写回和 PDF 模型工具；原生 worker 负责 PDF 渲染与文字提取。每个平台的安装包都包含这套 JS 插件及对应平台的 helper 和 PDFium 动态库，安装时不需要 C++ 编译环境。

源码按 `src/entrypoints/`（Cordis 装配）、`src/modules/`（工作副本、证据、模型写入、阅读视图等）、`src/adapters/`（DSH、文件、存储、PDFium/pdf-lib）、`src/contracts/` 和 `src/shared/` 分层。原有 V1 草稿、书签、阅读位置格式保持不变；新增文字证据使用独立、限量且有保留期的存储域。模型与界面写入复用同一工作副本事务。`pdf_read_page`、`pdf_locate`、`pdf_context` 的工具结果有可回放的文字卡片；点击回到当前可见 PDF 时会重新校验来源和引文，这不等于模型已能主动导航。设计与落地状态见 [架构 V2](./docs/ARCHITECTURE_V2.md) 和 [AI 阅读工具](./docs/AI_READER_TOOLS.md)。开发检查使用 `npm run check`，浏览器交互使用 `npm run test:web`，Node＋浏览器＋原生的项目级行覆盖率使用 `npm run test:coverage:project`；是否通过以实际运行报告为准。

例如，仅对指定 profile 使用 OCR 文字路线时，在该 profile 的 `cordis.patch.yml` 中合并以下覆盖项（不要覆盖文件内已有的 patch）：

```yaml
- id: pdf-image-understanding
  config:
    backend: ocr-text
```

此配置只选择图像理解路线；OCR 引擎仍由 `image-ocr` 自己配置。

使用内置辅助视觉路线时，改为以下配置；`provider` 和 `model` 必须是 DSH 已配置且声明支持图像输入的精确标识，`reasoningEffort`、`maxOutputTokens` 可省略：

```yaml
- id: pdf-image-understanding
  config:
    backend: auxiliary-vision
    auxiliaryVision:
      provider: your-provider
      model: your-vision-model
      # reasoningEffort: low
      # maxOutputTokens: 4096
```

这一路线会把框选截图和对应问题发送给该辅助模型；它返回的描述可能遗漏细节或出错，当前会话不会看到原图。若还需要其他路线，Host 插件仍可向 `imageUnderstanding` 注册自定义后端并在 `config.backend` 中选择其 ID。

界面契约（含自定义 UI 组件的现状清单与收敛待办）见 [SPEC.md](./SPEC.md)；已完成与待测的性能口径见 [PERFORMANCE.md](./PERFORMANCE.md)。

## 许可证

本项目代码采用 [MIT License](./LICENSE)。PDFium、pdf-lib、Tesseract.js 等第三方组件遵循各自的许可证；构建包内附有 `dist/THIRD_PARTY_NOTICES.md` 与 `dist/native/` 下的许可文本。

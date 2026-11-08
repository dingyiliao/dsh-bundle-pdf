# DSH PDF 阅读器

[English](README.md) | 中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中一边对话，一边阅读 PDF。让模型查找相关原文、添加标注、跳转定位，再回到之前的阅读位置。

我常用 PDF 读论文和书。常用阅读器缺少多级回退，带 AI 解读和翻译的产品又常需额外订阅，于是借助 DSH 写了这个插件。

## 功能

- **阅读与导航**：连续滚动、缩放、缩略图、文字搜索，以及可选择历史位置的多级回退。
- **标注与书签**：高亮、下划线、删除线、批注、可拖动和调整尺寸的便签；编辑 PDF 内置书签及其层级。
- **翻译与解释**：单词释义、音标和例句；短语与句子翻译；收集多段文字或图像区域，分别提问后发送给当前会话。
- **模型操作**：读页、检索、标注、编辑书签和填写已有 AcroForm 表单，与用户共用草稿。
- **保存与恢复**：撤销／重做、草稿恢复、保存／另存为和源文件冲突检测。
- **OCR 与检索**：区域截图、文字识别，以及基于自配 embedding 模型的语义搜索（实验功能）。索引持久化到磁盘，支持扫描页文字、图像描述、失败续建，重启或仅保存标注后继续复用。

## 功能演示

点击截图查看原尺寸。

- **按语义找原文**\
  只记得大意，或不确定书里有没有讲过？启用语义检索后，用自己的话问模型，它会按意思查找相关段落，还能帮你标记并跳转。

  [![左侧是对话，右侧是第 47 页被高亮的考试类比和批注标记](docs/screenshots/reader-overview.png)](docs/screenshots/reader-overview.png)

- **多处疑问一起问**\
  读到几处不懂的内容时，可以在解释模式里给每段选文或区域截图分别写下问题，再一起发到当前会话。

  [![带编号的 PDF 选段及解释材料列表中的两个问题](docs/screenshots/explanation-mode.png)](docs/screenshots/explanation-mode.png)

- **多级回退**\
  跳了几次页，想回到刚才读的地方？打开回退菜单，选中之前的位置就能直接回去。

  [![第 156 页打开的回退菜单，列出了四个历史阅读位置](docs/screenshots/navigation-history.png)](docs/screenshots/navigation-history.png)

- **扫描目录转书签**\
  扫描版的书没有书签时，可以让模型读取目录、校准页码，生成可点击跳转的多级书签。

  [![扫描版教材及侧栏中自动生成的章节书签](docs/screenshots/scanned-pdf-bookmarks.png)](docs/screenshots/scanned-pdf-bookmarks.png)

- **翻译扫描页文字**\
  扫描页的文字选不中？框住要翻译的段落，插件会先识别文字，再在侧栏显示译文。也可以直接在会话里要求模型进行翻译，模型会调用相应的工具进行处理。

  [![扫描版教材及翻译侧栏中的中文原文和英文译文](docs/screenshots/scanned-pdf-translation.png)](docs/screenshots/scanned-pdf-translation.png)

## 安装

已验证 DSH `0.2.2-rc.1`。支持的版本见 [package.json](package.json)。

请使用下方 npm 包名安装，不要使用 GitHub 链接。源码仓库不含 `dist/`，直接安装会因缺少入口文件而无法启用插件。

- **GUI**：打开 **插件 → 添加插件**，输入 `@dylanl1/dsh-plugin-pdf`，安装后点击 **立即启用**。

- **CLI**：将 `<profile>` 替换为所用 profile：

  ```sh
  dsh plugin --profile <profile> add @dylanl1/dsh-plugin-pdf
  ```

  Desktop 用户需通过应用菜单的 **管理 dsh 命令…** 安装自带 CLI。先启动一次 Desktop，再完全退出，以 `--profile desktop` 安装后重新打开；单独通过 npm 安装的 CLI 不能管理桌面版插件。

本插件自带一个小型 OCR 模型，支持中英文识别。在 PDF 设置中选择 **Local Tesseract OCR** 即可使用（默认选项）。

## 模型工具

- 文档：`pdf_current`、`pdf_open`、`pdf_close`、`pdf_info`、`pdf_status`。
- 阅读：`pdf_page_read`、`pdf_page_render`。
- 检索与证据：`pdf_keyword_search`、`pdf_semantic_search`、`pdf_evidence_read`。
- 标注：`pdf_annotation_list`、`pdf_annotation_create`、`pdf_annotation_update`、`pdf_annotation_delete`。
- 书签：`pdf_bookmark_list`、`pdf_bookmark_edit`。
- 表单：`pdf_form_inspect`、`pdf_form_fill`。
- 导航与保存：`pdf_page_jump`、`pdf_save`。
- 图像：`ocr_recognize`、`image_understand`。

`pdf_open` 只在后台打开文档；跳转需要阅读器已显示。模型编辑直接写入草稿，覆盖保存原文件仍需用户确认。参数和示例见[工具文档](docs/agent-tools.md)。

## 扩展引擎

OCR、图像理解、翻译和 embedding 均支持第三方实现。将扩展写成独立的 DSH Host 插件，在 `peerDependencies` 中声明本包，通过公开 SDK 向对应服务注册后端，并安装到相同 Host profile，即可在 PDF 设置中选择。

参考 [`examples/`](examples/README.md) 中的 [`http-engines`](examples/http-engines)：一个提供 HTTP OCR 和图像理解后端的独立插件。接口与生命周期约定见[引擎扩展](docs/engine-extensions.md)。

## 架构

```mermaid
flowchart TB
  Reader["Client · PDF 阅读器"] <--> RPC
  Model["DSH 会话模型"] -- "工具调用" --> Features
  subgraph Host
    RPC["鉴权 RPC"] --> Features["PDF 领域能力"]
    Features --> Copy["共享工作副本 · 草稿与撤销"]
    Features --> Search["检索与证据"]
    Features --> Engines["可扩展 AI 引擎"]
    Search --> Copy
    Search --> Engines
    Search --> Index[("磁盘索引与检查点")]
    Copy --> PDF["PDFium · pdf-lib"]
    Copy --> Storage["文件与草稿存储"]
  end
```

阅读器与模型工具共用 Host 业务能力和同一资源会话内的工作副本，修改双向同步。原生 PDFium worker 负责渲染和文字提取。详见[架构文档](docs/architecture.md)。

## 开发

```sh
npm ci
npm run native:build
npm run build
```

检查与测试：`npm run check`、`npm run test:web`、`npm run test:coverage:project`。另见[语义检索配置与基准测试](docs/retrieval.md)、[打包与发布](docs/releasing.md)。

## 许可证

[MIT](LICENSE)。发布包附带所用原生组件及依赖的第三方许可证。

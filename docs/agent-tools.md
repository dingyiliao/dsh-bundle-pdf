# PDF 模型工具契约

本文定义模型工具的职责、调用方式和结果约束。工具提供材料和确定性动作，由模型组合阅读、搜索、解释与编辑流程。

纯状态、ID、修订及操作结果直接输出 JSON。返回包含文档文字或图像时，保留一条简短的不可信内容标记；写操作回显的覆盖原文、表单校验错误中的原生字段名也按文档内容处理。标记只描述内容来源，不改变返回数据、证据校验或工具卡元数据。

## 工具列表

| 工具 | 职责 |
| --- | --- |
| `pdf_current` | 列出本会话可见 Reader 的文档 ID、标签 ID 和当前页提示 |
| `pdf_open` | 为模型取得 PDF 工作副本引用，不打开 Reader 标签 |
| `pdf_close` | 释放模型引用，不关闭 UI、不删除草稿 |
| `pdf_info` | 读取文件元信息，不创建持久工作副本或模型引用 |
| `pdf_status` | 查询已打开文档的修订、未保存状态、冲突及实际可用能力 |
| `pdf_page_read` | 读取有界页面文字，并签发可复用证据引用 |
| `pdf_page_render` | 生成页面图像和可信图像句柄，不执行 OCR 或识图 |
| `pdf_keyword_search` | 精确或显式归一化字符串搜索，返回具体出现位置的引用 |
| `pdf_semantic_search` | 使用已配置且可用的 embedding 引擎检索原生文字、OCR 及可选图像描述 |
| `pdf_evidence_read` | 重读／缩小已有证据，或解析单页、跨页连续文字范围 |
| `pdf_page_jump` | 在已可见的 Reader 中跳转到页或精确引用，并记录多级回退 |
| `pdf_form_inspect` | 返回同一快照的编号页图、字段类型、选项及 inspection ID |
| `pdf_form_fill` | 原子填写一个已检查页面的草稿 |
| `pdf_annotation_list` | 列出当前草稿中的标注、评论及精确 ID |
| `pdf_annotation_create` | 根据已解析文字引用或便签区域，单项或原子批量创建标注 |
| `pdf_annotation_update` | 修改已有标注颜色或评论文本，保留其身份与回复关系 |
| `pdf_annotation_delete` | 删除指定可编辑标注或评论 |
| `pdf_bookmark_list` | 读取 PDF 内置书签树和精确 outline ID |
| `pdf_bookmark_edit` | 在一个草稿事务中新增、修改、删除或移动书签 |
| `pdf_save` | 经受信用户确认后，将当前草稿覆盖保存到原 PDF |
| `ocr_recognize` | 使用配置的 OCR 引擎识别一个可信图像句柄 |
| `image_understand` | 使用配置的图像理解后端处理一个可信图像句柄 |

## 文档身份与生命周期

所有资源以执行中的 Agent 会话鉴权；`documentId`、`refId`、`searchId` 和 `inspectionId` 都不能代替文件访问权限。

`working-copy` 是唯一的打开文档表。同一会话、同一规范路径，无论先通过模型还是 UI 打开，都获得同一份文档、草稿、修订和撤销历史。重复的模型打开取得同一个模型持有者，不因工具重试无限增加引用。UI 标签、模型持有者和执行中的操作分别持有引用。

`pdf_close` 仅释放模型持有者。引用归零后可以回收常驻字节和 native 资源，持久草稿仍保留；空闲回收不授权模型关闭用户视图或删除未保存修改。Host 重启后重新打开以获取有效 ID。

`pdf_info` 检查文件本身的元信息，不登记长期模型所有权；`pdf_status` 检查工作副本当前状态，不能用重复打开来替代状态查询。能力报告中的 `supported/available/reason` 是观察结果，执行时仍重新验证。

## 搜索、读取与证据

`pdf_keyword_search` 搜索字面原文，`mode: "exact"` 区分大小写，显式 `mode: "normalized"` 折叠大小写和空白并保留原始偏移。`pdf_semantic_search` 用于概念、问题或不同表述；没有可用 embedding 引擎时报告不可用，不把关键词结果伪装成语义检索。语义索引复用统一 `PageContent` 的原生文字、OCR 文字及可选图像描述，并保留来源位置。图像描述对应整页 `visual-region`，不提供独立图表、表格或公式区域检测。

开始语义搜索前，先用该 `documentId` 调用 `pdf_status`，仅在 `capabilities.semanticSearch` 为 `true` 时调用 `pdf_semantic_search`。为 `false` 时读取 `capabilityDetails.semanticSearch.reason`；引擎关闭、缺失或不可用时，组合 `pdf_keyword_search` 的相关词搜索与 `pdf_page_read` 的上下文阅读，并明确这是关键词检索和阅读判断，不能称为语义搜索结果。未经用户明确要求，不启用、切换或修改 embedding 引擎及其配置。`pdf_current` 的文档和页提示不代表语义搜索可用。

索引配置、持久化、复用和恢复规则见[检索文档](retrieval.md)。工具消费对应文档的生效索引策略；索引及内容块身份不代替会话授权或证据引用。

两种搜索首调传 `documentId`、`query` 和范围等初始参数。返回 `searchId` 与 `hasMore`；续调只传同一工具返回的 `{searchId}`。Host 保留查询、范围、版本和进度。未知／过期／错误工具的 ID 必须重新搜索。未完成覆盖不能据此断言无结果或唯一结果；相关检索处理完请求范围后对可用内容统一排名，局部失败时仍可能有候选。

若可选 OCR／图像描述失败但已有有效原生或 OCR 文字，索引保留可用内容，返回 `status: incomplete` 和 `coverage.failedPages`，可以带排名候选。此时 `hasMore: false` 只表示没有后续构建步骤，不表示覆盖完整，也没有可继续的游标；不要重复续调。可通过继续／重试索引补齐失败步骤，源文件或计划变化时改用更新索引。不能宣称索引整体就绪。没有任何有效文字的失败页仍可重试；成功但空白的 OCR 输出不算失败。

语义结果的 `coverage.qualityWarnings` 按相同问题聚合：`message` 仅出现一次，`affectedPageCount` 是受影响页数，`candidatePages` 精确列出本次命中中受影响的页，`sampleOtherPages` 最多列出 8 个其他页，`omittedPageCount` 明确报告未列出的页数。最多返回 8 类警告，优先呈现影响当前候选的类型；更多类型以 `qualityWarningsOmitted` 汇总，不能把省略当作无问题。`complete` 表示请求范围的索引已完成且无失败页，不表示每个字符都已准确解码；字符缺失与 `failedPages` 的读取／预处理失败分别报告。质量信号按页统计，是否影响具体引文仍需结合原文核对。对相关页的关键文字或符号有疑问时用 `pdf_page_read` 补读，必要时用 `pdf_page_render` 视觉核对。

读取与搜索返回可复用的 `refId`。页面读取、语义搜索和文字证据读取的模型输出每段正文只保留一份，分别使用 `text`、候选的 `quote` 和 `pages[].text`；证据描述保留引用、来源、精度、能力和限制，不重复嵌入 `snapshot`、摘要或几何。完整有界快照和重验信息仍由 Host 及工具卡元数据保留。

`capabilities` 由 Host 根据实际来源推导，包含 `source/textMatching/navigation/exactAnnotate/reason`：

| 来源 | `textMatching` | 匹配与导航能力 |
| --- | --- | --- |
| `native-text` | `exact` | 对应原生文字的具体 UTF-16 范围；可解析引用内唯一子段，支持精确范围导航和标注 |
| `local-ocr` | `derived` | 只能在 OCR 快照内缩小文字范围；`page-only` 导航，不支持原生文字标注 |
| `ocr-text`、`auxiliary-vision` | `derived` | 派生文字；只导航至已验证的来源页，不支持原生文字标注 |
| `direct-image` | `none` | 图像证据；只导航至已验证的来源页，无原生文字范围 |

`exactAnnotate: true` 仅表示来源支持精确标注，执行时仍须重验来源、整页文字、修订和原生字形；客户端自报能力、OCR 坐标或相同文字的另一出现位置都不能授权标注。引用可能大于所需段落，应先缩小再写入。

文字引用固定使用签发时的原生或 local OCR 表示。复读、缩小、原生几何解析和 Reader 跳转核对沿用该表示，不因普通读页自动启用 OCR 而换源。Reader 的原生与修复文字分别缓存。Host 观察到原生页有未解码字符时，保守报告 `exactAnnotate: false` 并说明原因；文字仍可复读和缩小，具体子段是否可精确操作仍由 Host 的来源和字形校验决定。旧引用复读也更新这些质量观察，不降低校验要求。

`pdf_evidence_read` 有两种输入：

```json
{"documentId":"doc-id","refId":"ref-id","quote":"可选：引用内部唯一的精确子段"}
```

`quote` 默认使用 `quoteMatch: "exact"`，保留换行等所有字符。显式 `quoteMatch: "whitespace-normalized"` 只将连续空白折为一个空格，唯一匹配后映回原始 UTF-16 范围；不裁剪首尾、不折叠大小写、标点、断字或 Unicode 组合形式。两种模式都只匹配父引用内部，多义或越界时拒绝。exact 仅因空白不同而失败时返回 `pdf/quote-whitespace-mismatch` 和 `retryHint`，可使用同一父 `refId` 与 `quote` 显式重试，不扩大范围。`quoteMatch` 必须与 `quote` 一起使用。

```json
{
  "documentId":"doc-id",
  "range":{
    "start":{"page":3,"quote":"唯一的起点原文"},
    "end":{"page":5,"quote":"唯一的终点原文"}
  }
}
```

`range` 使用精确起止引文，包含起止之间的全部页和文字，最多十页、8,000 UTF-16 字符。Host 验证来源、页文字和原生几何；阅读顺序不明确、引文歧义、文字映射不可靠或范围过大时拒绝。缩小或解析成功后用返回的最终 `refId` 创建标注和跳转。

已保存的图像或 OCR／识图结果句柄重放不重新推理。local OCR 文字引用的重验优先复用页面缓存，缓存缺失时可能重新识别，再核对整页文字摘要、提取来源和原范围。Host 始终重验会话、文档版本和源文件，图像句柄还校验附件摘要；local OCR 要求源 PDF 字节与存证一致，已失效时重新读取。

列表工具沿用各自的 `nextCursor/cursor`，游标必须原样传回；文档变化后重新列举。搜索会话与列表游标不可混用。

## 图像、OCR 与区域交互

模型调用链：

```text
pdf_page_render → imageHandle → ocr_recognize / image_understand
```

页图生成仅生产图像和句柄。当前模型支持视觉时可接收图片自行理解；文本模型也可取得句柄交给后端，但不能声称看过图片。OCR 只提取文字；图像理解通过所选引擎实际执行“图片 + 提示词 → 文字”，均报告来源、限制和有界结果。内置 `dsh-vision` 可跟随会话或指定视觉模型；直接把图片交给视觉会话属于会话编排，不是另一种引擎，也不自动回退到 OCR。

`ocr_recognize` 首调传 `imageHandle`；`image_understand` 首调还需 `question`。两者都可设 `maxChars`。结果返回 `resultId`、`offset/nextOffset`、文字、来源及可用的证据；截断时用同一个工具的 `{resultId,offset:nextOffset}` 继续，不再传图像句柄或问题，也不重新发起识别。结果句柄有会话、工具、期限和来源约束；缺失或过期时重新生成图像／结果。OCR 几何若存在，坐标属于输入图像像素，不是可直接写入 PDF 的位置。

UI 区域 OCR 使用同一个识别服务：框选、裁剪和页面坐标映射由 Reader 链路处理，识别、取消、错误、限额及引擎选择共用 Host 服务。模型工具没有区域 OCR、`region` 或 `bbox` 参数。

普通页图不合成未保存的 Reader 草稿覆盖层，不能用它证明未保存表单值或标注外观已正确。图像生产与派生结果始终携带实际输入的来源约束。

## 标注、书签与导航

模型新增文本标注只接受已解析引用：

```json
{
  "documentId":"doc-id",
  "expectedRevision":4,
  "subtype":"Highlight",
  "target":{"kind":"reference","refId":"resolved-ref"},
  "comment":"可选评论"
}
```

多个独立段落使用同一请求的 `annotations:[{subtype,target,color?,comment?},…]`，不得与顶层 `subtype/target/color/comment` 混用。批量最多 50 项、100 个页标记、64,000 个文字字符及 64,000 个输入字符。所有引用先解析，整批共用一个 `expectedRevision`；有新增时通过一次 CAS 提交一个草稿事务、增加一次修订并产生一条撤销记录，全为复用则不增加修订。任一来源、几何、修订或重叠检查失败，整批零写入。结果逐项返回覆盖范围和标注 ID，应核对后再报告完成。同一文档的后续写入串行使用上一次成功结果的 `revision`。

独立便签使用 `subtype: "Text"` 和 `target: {kind:"pdf-region",page,rectPdf:[left,bottom,right,top]}`。一个引用可跨页，标注工具只消费最终引用，覆盖其完整范围；写入时仍重新验证来源、修订和原生字形。

完全相同的已有标注可以复用，省略颜色／评论保留原有复用规则；批内相同请求共用一个 ID，不同选项或部分重叠则整批拒绝并报告条目索引和冲突 ID。修改、删除使用 `pdf_annotation_list` 返回的完整 ID 和当前修订；更新不通过删后重建实现。评论回复先于父标注删除。

`pdf_bookmark_list` 仅列内置目录。`pdf_bookmark_edit` 接受结构化 `operations` 数组，一次 1–100 项 `outline-add/update/delete/move`。新增可指定父节点与插入位置；删除包括子树；移动位置按移出原子树后计算。仅改名或移动保留既有目的地、外链、样式和折叠状态，显式修改 `page` 才重设目的地。

`pdf_page_jump` 消费最终引用，或物理页码与当前 `contentVersion`；连续范围跳至起点，OCR 只跳至已验证的来源页且不生成 native 高亮目标。历史 OCR 工具卡必须提供与当前源字节一致的摘要，缺失或失效时重新读取；旧 native 卡仍可经整页文字与字形重验跨越仅标注保存。工具不隐式打开标签，同一文档多个 Reader 时用 `pdf_current` 的 `tabId` 明确目标。成功跳转进入相同的多级阅读回退历史；读取、检索和编辑不自动导航。

## 表单与保存

`pdf_form_inspect(documentId,page,includeValues?)` 返回两种内容块：精简结构化文本和编号页图。小型透明底 F 编号位于真实可写控件内；图像隐藏 widget 外观、填写值与标注。文本包含字段的原生共享键、类型、`valueType`、约束、选项和编号；`includeValues:true` 才返回实际草稿值。编号和映射来自同一快照，不由模型自己拼接。

`pdf_form_fill` 必填 `documentId`、一个 `inspectionId`、原始 `expectedRevision` 和 `fields:[{label,value}]`，不传页号。文本／单选／下拉为字符串，复选框为布尔，选项列表为字符串数组；清空分别用 `""`、`false`、`[]`。只能填写已暴露的真实可写控件；打印文字不代表控件。共享字段只提交一次。

单页写入是事务边界，不是理解边界。填写前理解相关说明、标题、主体、单位、日期格式及适用条件，必要时补读前页。模型可声明条件与互斥组，Host 只校验所提供规则和类型，不推断业务语义或伪造缺失信息。语义不明时阅读或询问。

可先检查多页再独立填写。Host 排队验证映射和修订；已知独立页填写可以保留无关检查，目标页、共享字段、依赖、UI 编辑、撤销重做或来源变化要求重新检查。每个单页批次一起成功或失败。填写后重新检查实际值；成功写入不代表语义正确。

所有修改直接进入人和模型共用的未保存草稿，不增加预演或人工确认。`pdf_save(documentId,expectedRevision)` 才通过受信交互渠道请求覆盖原文件的批准，再次核对修订、差异和源摘要后原子保存。模型不能以 `approved:true` 授权自己。另存为仍由 UI 路径选择器处理。

验证方法及运行命令见[测试指南](testing.md)。

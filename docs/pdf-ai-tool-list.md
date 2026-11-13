# PDF × AI Tool List

> **设计档案，非当前契约**：本文是 2026-10 的能力提案，包含未实现工具（如 `pdf_structure`、`pdf_redact`、`pdf_sign`）。当前模型工具以 [agent-tools.md](./agent-tools.md) 和实际注册为准。

> 面向 Agent / MCP 的 PDF 能力接口设计 · v1.0 · 2026-10

## TL;DR

只把**确定性动作**做成工具：读结构、定位、取上下文、改、签、校验。
不要做 `pdf_summarize` / `pdf_chat`——总结和问答是模型的事，工具只负责给它**正确的上下文**和**安全的操作**。

---

## 0. 设计原则

1. **工具做动作，模型做智能**
   `pdf_summarize`、`pdf_translate`、`pdf_answer` 都不该存在。工具的价值是"取到对的内容"+"改对地方"。
2. **读必带 provenance**
   每个返回块都带 `page + bbox + element_id + text_hash`，否则引用无法闭环。
3. **写必可预演**
   所有修改类工具支持 `dry_run`，返回 diff / preview；破坏性操作（redact / delete / sign）需显式确认。
4. **输出有界**
   `cursor` 分页、`max_chars`、字段过滤、`token_budget`；大文档转异步 job。
5. **错误可编程**
   返回结构化 `error.code`，不要让模型去解析自然语言报错。
6. **权限分级**
   `read / annotate / write / sign / export` 分开授权，redact 与 sign 单独审计。
7. **一个动作一个工具**
   不要 `pdf_do(everything)`；也不要一个 PDF 操作符一个工具。20–30 个是模型可选的舒适区。

---

## 1. 工具全景

### A. 文档生命周期

| 工具          | 作用                  | 关键输入                         | 关键输出                                          |
| ----------- | ------------------- | ---------------------------- | --------------------------------------------- |
| `pdf_open`  | 打开/登记文档，建立 `doc_id` | path / url / bytes、password? | `doc_id`、页数、加密状态、权限、是否 Tagged、文本层质量分、producer |
| `pdf_info`  | 元数据与文件特征            | `doc_id`                     | XMP、PDF 版本、线性化、文件大小、页标签                       |
| `pdf_list`  | 列出会话内文档             | —                            | `[{doc_id, title, pages}]`                    |
| `pdf_close` | 释放句柄                | `doc_id`                     | —                                             |

### B. 导航与检索

| 工具                 | 作用            | 关键输入                                 | 关键输出                                             |
| ------------------ | ------------- | ------------------------------------ | ------------------------------------------------ |
| `pdf_outline`      | 目录/书签树        | `doc_id`                             | 层级标题 + 目标页/结构元素                                  |
| `pdf_search`       | 全文检索          | `query`、`regex?`、`pages?`、`cursor`   | 命中列表 + bbox + 上下文 + `element_id`                 |
| `pdf_read_page`    | 按阅读顺序读一页      | `page`、`offset`、`max_chars`          | 文本窗口 + 续读 offset + artifact 标记                   |
| `pdf_read_section` | 按章节读（长文档首选）   | `element_id` 或标题路径                   | 该节全文 + 子结构                                       |
| `pdf_locate`       | 把引文/坐标解析成规范锚点 | `quote` / `element_id` / `page+bbox` | `{page, bbox, element_id, text_hash}` + 置信度 + 候选 |
| `pdf_links`        | 内外链接与命名目的地    | `doc_id`                             | 链接 + 目标锚点                                        |

### C. 语义抽取

| 工具                | 作用                    | 关键输入                                    | 关键输出                              |
| ----------------- | --------------------- | --------------------------------------- | --------------------------------- |
| `pdf_structure`   | 结构树（标题/段落/列表/图/公式/脚注） | `pages?`、`depth?`、`include_bbox`        | 节点数组 + 类型 + 层级 + 锚点 + warnings    |
| `pdf_tables`      | 表格结构与内容               | `pages?`、`format: cells\|markdown\|csv` | 单元格、表头、合并、跨页续表、bbox               |
| `pdf_forms`       | 表单字段 schema           | `doc_id`                                | 字段名/类型/值/选项/必填/bbox               |
| `pdf_annotations` | 读取注释与回复               | `pages?`                                | 注释列表 + 锚点 + 作者 + 状态               |
| `pdf_attachments` | 伴随文件（CSV/MathML/源文档）  | `doc_id`                                | 附件清单 + 内容句柄                       |
| `pdf_metadata`    | 授权与来源信息               | `doc_id`                                | license、TDM/训练/引用许可、C2PA 摘要、AI 标记 |

### D. 视觉与 OCR

| 工具                | 作用      | 关键输入                      | 关键输出                      |
| ----------------- | ------- | ------------------------- | ------------------------- |
| `pdf_render_page` | 渲染页面/区域 | `page`、`bbox?`、`max_edge` | 图像句柄（供视觉模型或人工核验）          |
| `pdf_ocr_page`    | 无文本层时兜底 | `page`、`region?`          | 文本 + 置信度 + bbox + 与图像对齐告警 |

### E. 上下文打包（RAG/Agent 的桥）

| 工具            | 作用            | 关键输入                                         | 关键输出                                                |
| ------------- | ------------- | -------------------------------------------- | --------------------------------------------------- |
| `pdf_context` | 按预算返回带引用的上下文包 | `query` 或 `section`、`token_budget`、`include` | 有序 chunks（含 element_id/bbox/章节路径）+ 覆盖报告（扫了哪些页、漏了什么） |

> 这是最值得做好的一个工具。它把"分块策略、表格序列化、去重、预算控制"从 prompt 里收回到确定性代码里。

### F. 修改与生成

| 工具                   | 作用                                                     | 关键输入                             | 关键输出              |
| -------------------- | ------------------------------------------------------ | -------------------------------- | ----------------- |
| `pdf_create`         | 从 md/html/docx/图片生成 PDF                                | 源内容、页面参数、`tagged=true`           | `doc_id` + 合规报告   |
| `pdf_pages`          | 页面操作（merge/split/extract/delete/reorder/rotate/insert） | `op` + 参数                        | 新 `doc_id` + diff |
| `pdf_annotate`       | 高亮/批注/图章/文本框                                           | `anchor`、类型、内容、颜色                | `annotation_id`   |
| `pdf_fill_form`      | 按字段写值                                                  | `values`、`flatten?`              | 结果 + 校验错误         |
| `pdf_set_metadata`   | 标题/作者/语言/许可/AI 标记                                      | 字段键值                             | 新版本               |
| `pdf_add_bookmark`   | 加书签                                                    | 标题 + `anchor`                    | —                 |
| `pdf_add_attachment` | 挂伴随文件                                                  | 文件 + 关系类型                        | —                 |
| `pdf_optimize`       | 线性化/压缩/子集化                                             | 目标                               | 体积变化 + 无障碍回归告警    |
| `pdf_redact`         | 真脱敏（删内容，非盖黑框）                                          | 引文/regex/锚点/区域、`remove_metadata` | 命中报告 + 预演         |
| `pdf_export`         | 导出 docx/xlsx/csv/json/md/html/图片                       | 格式、`layout` 或 `flow`             | 文件句柄              |

### G. 签名与信任

| 工具                   | 作用   | 关键输入          | 关键输出                           |
| -------------------- | ---- | ------------- | ------------------------------ |
| `pdf_sign`           | 数字签名 | 签名字段、证书、原因、位置 | 签名域 + 覆盖范围                     |
| `pdf_verify`         | 验签   | `doc_id`      | 有效性、证书链、时间戳、是否覆盖全文、签后是否增量修改    |
| `pdf_audit_security` | 安全审计 | `doc_id`      | 加密、权限、JS、Launch、嵌入文件、外链、增量更新次数 |

### H. 质量与合规

| 工具                       | 作用       | 关键输入                                            | 关键输出                                          |
| ------------------------ | -------- | ----------------------------------------------- | --------------------------------------------- |
| `pdf_validate`           | 合规校验     | profile: `pdf/a-4`、`pdf/ua-2`、`wtpdf`、`pdf-2.0` | 规则级报告 + 失败位置                                  |
| `pdf_check_ai_readiness` | AI 可读性评分 | `doc_id`                                        | 文本层/ToUnicode/标签/阅读顺序/表格/Alt/隐藏文本/OCR 对齐 的分项分 |
| `pdf_detect_hidden`      | 隐藏内容检测   | `doc_id`                                        | 白字、离屏、`Tr 3` 不可见渲染、超小字号、OCR 与图像错位             |
| `pdf_diff`               | 语义 diff  | 两个 `doc_id`                                     | 变更元素 + 锚点 + 变更类型                              |

### I. 异步

| 工具               | 作用                       |
| ---------------- | ------------------------ |
| `pdf_job_status` | 大文档 OCR/转换/校验的 job 查询与取消 |

---

## 2. 最小可用集（V1，12 个）

**读（9）**
`pdf_open` · `pdf_outline` · `pdf_read_section` · `pdf_search` · `pdf_structure` · `pdf_tables` · `pdf_render_page` · `pdf_locate` · `pdf_context`

**写（2）**
`pdf_annotate` · `pdf_fill_form`

**质量（1）**
`pdf_check_ai_readiness`

> 这 12 个就能支撑"读懂 + 引用 + 批注 + 填表 + 自检"的完整闭环。
> `pdf_redact`、`pdf_sign`、`pdf_export`、`pdf_validate`、`pdf_diff` 放 V2，但它们不是可选项，是上线门槛。

---

## 3. 核心 Schema 示例

### `pdf_structure`

```json
// input
{ "doc_id": "doc_7f3a", "pages": [3, 4], "depth": 4, "include_bbox": true }

// output
{
  "doc_id": "doc_7f3a",
  "tagged": true,
  "conformance": "WTPDF",
  "nodes": [
    {
      "id": "e_0012",
      "type": "heading",
      "level": 1,
      "text": "Financial Highlights",
      "page": 3,
      "bbox": [72.0, 640.2, 523.1, 668.9],
      "hash": "sha256:9c1e..."
    },
    {
      "id": "e_0013",
      "type": "table",
      "page": 4,
      "bbox": [72.0, 120.5, 523.1, 480.0],
      "headers": ["Metric", "2024", "2025"],
      "rows": 12,
      "continuation_of": null
    }
  ],
  "warnings": ["figure e_0044 missing alt text"]
}
```

### `pdf_locate`

```json
// input
{ "doc_id": "doc_7f3a", "quote": "revenue grew 23% year over year", "near_page": 4 }

// output
{
  "anchor": {
    "page": 4,
    "bbox": [310.2, 402.1, 498.7, 415.6],
    "element_id": "e_0031",
    "text_hash": "sha256:..."
  },
  "confidence": 0.98,
  "alternatives": []
}
```

### `pdf_context`

```json
// input
{
  "doc_id": "doc_7f3a",
  "query": "2025 revenue breakdown by region",
  "token_budget": 6000,
  "include": ["text", "tables"],
  "strategy": "section_first"
}

// output
{
  "chunks": [
    {
      "id": "c_01",
      "element_id": "e_0031",
      "page": 4,
      "bbox": [72.0, 380.0, 523.1, 470.0],
      "section_path": ["Financial Highlights", "Revenue"],
      "text": "...",
      "tokens": 412
    }
  ],
  "coverage": { "pages_scanned": [3, 4, 5], "omitted": ["appendix"] }
}
```

### `pdf_redact`

```json
// input
{
  "doc_id": "doc_7f3a",
  "targets": [
    { "quote": "John Doe" },
    { "regex": "\\b\\d{3}-\\d{2}-\\d{4}\\b" }
  ],
  "options": { "remove_metadata": true, "sanitize": true, "dry_run": true }
}

// output
{
  "matches": 7,
  "preview": [{ "page": 4, "bbox": [72.0, 300.0, 180.0, 315.0] }],
  "requires_confirmation": true
}
```

---

## 4. 功能 → 工具映射

| 上一轮的功能            | 暴露为工具                                                 | 说明                       |
| ----------------- | ----------------------------------------------------- | ------------------------ |
| Tagged PDF / 阅读顺序 | `pdf_structure` + `pdf_check_ai_readiness`            | 读结构 + 质量评分               |
| 表格语义              | `pdf_tables`                                          | 单元格/表头/合并/跨页             |
| 公式 / 图注           | `pdf_structure`（formula/figure 节点）+ `pdf_attachments` | MathML / 数据文件            |
| 稳定锚点              | `pdf_locate`                                          | quote/元素/坐标 → 规范锚点       |
| 引用回跳              | `pdf_context` + `pdf_render_page`                     | chunk 带 bbox，可截图核验       |
| 结构化表单             | `pdf_forms` + `pdf_fill_form`                         | 读 schema / 写值            |
| 注释协作              | `pdf_annotations`（读）+ `pdf_annotate`（写）               | 读写分离                     |
| 真脱敏               | `pdf_redact`                                          | 删除内容而非覆盖                 |
| 签名                | `pdf_sign` + `pdf_verify`                             | PAdES、覆盖范围、签后修改          |
| 授权元数据             | `pdf_metadata` + `pdf_set_metadata`                   | license / TDM / AI flags |
| 隐藏内容检测            | `pdf_detect_hidden`                                   | 白字/离屏/Tr 3/OCR 错位        |
| 语义 diff           | `pdf_diff`                                            | 条款级变更                    |
| 导出                | `pdf_export`                                          | docx/xlsx/json/md        |
| 无障碍校验             | `pdf_validate`（PDF/UA-2）                              | 规则级报告                    |

---

## 5. 不该做成 tool 的事

| 不做                                             | 原因                  | 正确做法                      |
| ---------------------------------------------- | ------------------- | ------------------------- |
| `pdf_summarize` / `pdf_chat` / `pdf_translate` | 模型能力，工具化后无法换模型、无法审计 | 用 `pdf_context` 供料，模型自己生成 |
| `pdf_edit_text`（任意改字）                          | PDF 无流式文本模型，改字必错位   | 重新生成，或 `pdf_annotate` 叠加  |
| `pdf_run_javascript`                           | 任意代码执行              | 禁用；必要时沙箱 + 白名单            |
| `pdf_crack_password`                           | 合规风险                | 拒绝                        |
| `pdf_fetch_url`                                | SSRF                | 交给通用 fetch + 域名白名单        |
| 一个工具塞所有操作                                      | 模型选不准               | 按动作拆分                     |

---

## 6. 错误码

| code                      | 含义                   | 客户端动作            |
| ------------------------- | -------------------- | ---------------- |
| `PASSWORD_REQUIRED`       | 加密文档                 | 请求密码             |
| `PERMISSION_DENIED`       | 权限不足                 | 提示/升级            |
| `NO_TEXT_LAYER`           | 无文本层                 | 转 `pdf_ocr_page` |
| `SCANNED`                 | 扫描件                  | OCR + 质量检查       |
| `MALFORMED`               | 结构损坏                 | 修复模式重开           |
| `ANCHOR_NOT_FOUND`        | 定位失败                 | 扩大搜索 / 回退页码      |
| `ANCHOR_AMBIGUOUS`        | 多处匹配                 | 返回候选让模型选         |
| `UNSUPPORTED`             | XFA / 3D / portfolio | 降级处理             |
| `VALIDATION_FAILED`       | 合规失败                 | 返回规则与位置          |
| `WOULD_BREAK_A11Y`        | 修改破坏无障碍              | 阻止或警告            |
| `SIGNATURE_INVALID`       | 签名无效                 | 阻断               |
| `DOC_MODIFIED_AFTER_SIGN` | 签后增量修改               | 提示覆盖范围           |
| `TOO_LARGE`               | 超限                   | 转异步 job          |

---

## 7. 权限模型

| scope          | 覆盖工具                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| `pdf:read`     | open / info / outline / search / read / structure / tables / render / locate / context |
| `pdf:annotate` | annotate / bookmark                                                                    |
| `pdf:write`    | fill_form / pages / metadata / redact / optimize / attachment                          |
| `pdf:sign`     | sign                                                                                   |
| `pdf:export`   | export                                                                                 |
| `pdf:admin`    | audit / validate / diff / job 管理                                                       |

> `redact` 虽在 `pdf:write`，但必须额外 `confirm=true` + 审计日志；`sign` 永远独立授权。

---

## 8. 落地建议

- **MCP 映射**：文档作为 resource（`pdf://doc/{id}/page/{n}`），操作为 tool；大结果走 resource link，不塞进对话。
- **并发**：`doc_id` + `version`（ETag）；写操作带 `if_version`，返回新版本，避免覆盖。
- **审计**：每次写操作记录 `actor / tool / targets / diff / timestamp`。
- **工具 schema 版本化**：`pdf_structure@2`，避免破坏已有 Agent。
- **评测**：用"引用准确率 + 表格还原 F1 + 脱敏召回"三件事衡量，而不是"看起来能用"。

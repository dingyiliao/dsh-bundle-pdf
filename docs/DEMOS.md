# 功能素材与复现说明

本页对应 README 中的 5 张截图和 2 段演示。所有素材来自当前版本的实际运行界面；演示视频用同一批实拍画面串联操作结果，没有概念图或伪造工具返回。

## 截图

1. `01-ai-edits-pdf.png`：模型读取原文后创建高亮和评论，阅读器同步显示未保存草稿。
2. `02-bookmarks-and-outline.png`：内置目录、用户书签与当前定位。
3. `03-notes-and-annotations.png`：高亮、评论和可编辑便签的实际效果。
4. `04-multilevel-back-history.png`：连续阅读中的多级返回历史。
5. `05-model-tool-workflow.png`：DSH 对话执行器与模型工具工作流界面。

## 演示录屏

- `01-reading-and-ai-understanding.mp4`：阅读、导航和模型理解流程概览。
- `02-agent-tool-collaboration.mp4`：模型创建标注、批注和书签后，阅读器同步显示结果。

视频没有音轨；画面中的对话文本和界面状态即为简短操作说明。

## 复现

1. 按 README 安装并启用插件，从 DSH 文件侧栏打开一份可公开的 PDF。
2. 用搜索和目录跳转到目标页；打开返回历史可复现导航画面。
3. 在对话中让模型先调用 `pdf_page_read` 或 `pdf_keyword_search`，用 `pdf_evidence_read` 确认范围，再调用 `pdf_annotation_create`；打开标注侧栏查看共享草稿。
4. 用 `pdf_bookmark_list` 获取真实 outline ID，再用 `pdf_bookmark_edit` 修改书签树。
5. OCR 需配置可用的 OCR 引擎；调用链为 `pdf_page_render` → `ocr_recognize`。语义检索是实验功能，默认关闭，必须先配置 embedding 服务并在 `pdf_status` 中确认 `capabilities.semanticSearch` 为 `true`；否则应使用关键词检索，不应将结果称为语义检索。
6. 模型编辑会直接进入未保存草稿。覆盖原 PDF 仍需通过 `pdf_save` 的受信确认；也可在阅读器中另存为。

为避免泄露信息，复现时请使用公开 PDF，并在采集前确认画面中没有账号、密钥或个人路径。

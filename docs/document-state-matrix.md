# 文档状态与所有权矩阵

> 状态说明：本文件记录 P0 阶段的设计决策，作为实现参考；当前运行时行为以代码和 [架构文档](./architecture.md) 为准。

状态：P0 草案。目标是防止 UI、Host、Native、索引和会话各自维护一套文档状态。

## 状态所有者

| 状态 | 唯一所有者 | 同一资源会话 | 跨会话 | 持久化 |
| --- | --- | --- | --- | --- |
| 源文件路径和文件观察信息 | filesystem adapter / Host | 共享 | 按路径重新发现 | 否，路径可重建 |
| 源文件字节摘要 | Host document service | 共享 | 可验证复用 | 是 |
| 工作副本操作日志 | working-copy service | UI 和模型共享 | 默认不共享 | 是 |
| 工作副本 revision | working-copy service | 共享并 CAS 校验 | 不直接共享 | 是 |
| Native handle | Native worker | 可被同一副本租用 | 不共享 | 否 |
| 页面内容和索引产物 | retrieval/content service | 可读 | 内容身份相同且授权允许时共享 | 是 |
| 索引任务状态 | retrieval task service | 任务所属会话可见 | 共享任务状态，但不共享权限 | 是 |
| 阅读位置、滚动锚点 | Client occurrence | 标签实例内 | 不共享 | 可选 |
| 解释问题和输入草稿 | Client occurrence | 标签实例内 | 不共享 | 否 |
| evidence handle | evidence service | 当前资源会话有效 | 不直接复用，重新签发 | 有界保存 |
| 密码和受保护草稿 | working-copy 内存边界 | 当前授权范围 | 不共享 | 不保存密码 |

## 不变量

- UI 手动打开和模型 `pdf_open` 取得同一工作副本。
- UI 和模型的编辑推进同一 revision，并进入同一撤销历史。
- Native handle 不是草稿所有者，Worker 重启后可由 Host 按操作日志重建。
- 跨会话只复用可验证的只读派生内容，不复用未保存草稿、授权、阅读位置和证据句柄。
- 加密权限、签名只读、批注权限和保存批准范围不能因统一入口而扩大。
- Client 临时交互状态不需要提升为 Host 文档事实。

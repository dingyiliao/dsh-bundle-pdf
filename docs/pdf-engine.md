# PDF 引擎模块

PDF 引擎代码按运行边界组织在两个位置：

- `src/native-boundary/protocol/`：Node 与原生 worker 之间的命令、响应和几何数据契约。
- `src/native-boundary/host/`：原生进程、二进制帧、队列、取消和句柄租约；只依赖协议和原生运行时。
- `src/capabilities/pdfium/`：PDFium 文档适配、元数据、标注、表单、书签和保存字节；这里组合业务操作并调用 native worker。
- `src/native-boundary/client/`：客户端选区几何、页内命中索引和选区覆盖层。
- `native/`：PDFium worker 与 CMake 入口。
- `native/pdfium/`：固定上游 revision 的 SDK 构建入口和统一补丁队列；`patches/patchset.json` 固定有序 `.patch` 文件及来源 revision，所有扩展源码也作为补丁新增文件纳入摘要。

阅读器、模型工具和保存流程都通过 `src/native-boundary/protocol/` 与同一个 PDFium worker 交互。Client 只负责选区和展示，Host 负责文档权限、工作副本和持久化；不会在 Client 中再实现一套 PDF 读写逻辑。

原生 SDK 的构建方式见[原生 PDF 实现](../native-pdf.md)和[`native/pdfium/README.md`](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/native/pdfium/README.md)。

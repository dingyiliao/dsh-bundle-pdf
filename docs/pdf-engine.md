# PDF 引擎模块

PDF 引擎代码按运行边界组织在两个位置：

- `src/engine/protocol/`：Node 与原生 worker 之间的命令、响应和几何数据契约。
- `src/engine/host/`：原生进程、二进制帧、队列、取消和句柄租约；只依赖协议和原生运行时。
- `src/adapters/host/pdfium/`：PDFium 文档适配、元数据、标注、表单、书签和保存字节；这里组合业务操作并调用 native worker。
- `src/engine/client/`：客户端选区几何、页内命中索引和选区覆盖层。
- `native/`：PDFium worker 与 CMake 入口。
- `native/pdfium/`：PDFium 补丁、扩展头文件、扩展源码和 SDK 构建脚本。

阅读器、模型工具和保存流程都通过 `src/engine/protocol/` 与同一个 PDFium worker 交互。Client 只负责选区和展示，Host 负责文档权限、工作副本和持久化；不会在 Client 中再实现一套 PDF 读写逻辑。

原生 SDK 的构建方式见[原生 PDF 实现](../native-pdf.md)和[`native/pdfium/README.md`](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/native/pdfium/README.md)。

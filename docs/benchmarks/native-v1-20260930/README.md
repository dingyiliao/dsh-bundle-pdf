# 原生第一版 smoke 对照记录

记录日期：2026-09-30。共 54 个成功场景，3 个合成样本 × 3 个场景 × 3 次重复 × 2 种阅读路径。原始数据、完整指标对照和源码摘要保存在本目录。

本记录比较同一新实现中的 legacy 与 native 配置，使用相同冻结测量协议；不是历史发行版本与新版本的全流程发布证明。计时从测试应用已加载开始，包括 Host 首次检查、原生启动和可见绘制；不包括浏览器启动、JS 包下载和 DSH 完整应用加载。样本数仅支持探索性判断。

| 样本 / 场景 | 指标 | legacy p50 | native p50 | 变化 |
| --- | --- | --- | --- | --- |
| text-1000 / reader.open | targetQualityProxyMs | 445.400 | 327.300 | -26.5% |
| text-1000 / reader.open | mountedPageWrappers | 1000.000 | 2.000 | -99.8% |
| text-1000 / reader.open | canvasPixelBytesEstimate | 32576768.000 | 16288384.000 | -50.0% |
| text-1000 / reader.open | rpcResponseBytes | 2563693.000 | 553925.000 | -78.4% |
| text-1000 / reader.zoom4x | targetQualityProxyMs | 503.200 | 402.000 | -20.1% |
| text-1000 / reader.zoom4x | mountedPageWrappers | 1000.000 | 1.000 | -99.9% |
| text-1000 / reader.zoom4x | canvasPixelBytesEstimate | 96022128.000 | 36327392.000 | -62.2% |
| text-1000 / reader.zoom4x | rpcResponseBytes | 2563693.000 | 1449489.000 | -43.5% |
| text-1000 / reader.scroll | rafIntervalP95Ms | 18.500 | 17.900 | -3.2% |
| text-1000 / reader.scroll | blankAreaTimeRatio | 0.000 | 0.000 | — |
| text-1000 / reader.scroll | canvasPixelBytesEstimate | 32853920.000 | 25692768.000 | -21.8% |
| text-1000 / reader.scroll | rpcResponseBytes | 2563693.000 | 3300429.000 | +28.7% |
| paper-12 / reader.open | targetQualityProxyMs | 203.800 | 251.800 | +23.6% |
| paper-12 / reader.open | mountedPageWrappers | 12.000 | 2.000 | -83.3% |
| paper-12 / reader.open | canvasPixelBytesEstimate | 32576768.000 | 16288384.000 | -50.0% |
| paper-12 / reader.open | rpcResponseBytes | 32037.000 | 465426.000 | +1352.8% |
| paper-12 / reader.zoom4x | targetQualityProxyMs | 635.300 | 416.100 | -34.5% |
| paper-12 / reader.zoom4x | mountedPageWrappers | 12.000 | 1.000 | -91.7% |
| paper-12 / reader.zoom4x | canvasPixelBytesEstimate | 96022128.000 | 38424544.000 | -60.0% |
| paper-12 / reader.zoom4x | rpcResponseBytes | 32037.000 | 1358801.000 | +4141.3% |
| paper-12 / reader.scroll | rafIntervalP95Ms | 17.100 | 18.500 | +8.2% |
| paper-12 / reader.scroll | blankAreaTimeRatio | 0.000 | 0.000 | — |
| paper-12 / reader.scroll | canvasPixelBytesEstimate | 32853920.000 | 25692768.000 | -21.8% |
| paper-12 / reader.scroll | rpcResponseBytes | 32037.000 | 3199241.000 | +9886.1% |
| annotations-1000 / reader.open | targetQualityProxyMs | 365.700 | 596.000 | +63.0% |
| annotations-1000 / reader.open | mountedPageWrappers | 12.000 | 2.000 | -83.3% |
| annotations-1000 / reader.open | canvasPixelBytesEstimate | 32576768.000 | 16288384.000 | -50.0% |
| annotations-1000 / reader.open | rpcResponseBytes | 1640461.000 | 1009595.000 | -38.5% |
| annotations-1000 / reader.zoom4x | targetQualityProxyMs | 366.900 | 729.500 | +98.8% |
| annotations-1000 / reader.zoom4x | mountedPageWrappers | 12.000 | 1.000 | -91.7% |
| annotations-1000 / reader.zoom4x | canvasPixelBytesEstimate | 96022128.000 | 43551360.000 | -54.6% |
| annotations-1000 / reader.zoom4x | rpcResponseBytes | 1640461.000 | 1769918.000 | +7.9% |
| annotations-1000 / reader.scroll | rafIntervalP95Ms | 18.400 | 19.000 | +3.3% |
| annotations-1000 / reader.scroll | blankAreaTimeRatio | 0.000 | 0.759 | — |
| annotations-1000 / reader.scroll | canvasPixelBytesEstimate | 32853920.000 | 23599744.000 | -28.2% |
| annotations-1000 / reader.scroll | rpcResponseBytes | 1640461.000 | 3150234.000 | +92.0% |

千页首屏页容器从 1000 降到 2，4 倍缩放场景中的画布像素估计从约 91.6 MiB 降到 34.6 MiB。千页首屏目标质量 p50 为 445.4 → 327.3 ms，4 倍缩放为 503.2 → 402.0 ms。该数据支持长文档 DOM、传输及高倍画布占用的改进。

保留反向结果：12 页首屏和 1000 标注文档的部分场景更慢；滚动会多次请求分块，累计响应字节可能多于一次发送整份小 PDF。原生进程启动、PNG 编码及重复遍历页面内容仍需优化。不得据此宣称所有场景均加速，或把画布像素估计称作总内存降幅。

浏览器总 RSS 未测得，数据中为 null/unavailable；helper 输入字节和 PNG 缓存为独立记账，不能补足该指标。发布前仍需至少 20 次重复、真实扫描/CJK/复杂字体/透明图形语料、OS/浏览器/helper 全进程资源测量与图像复核。

重跑命令与所有指标定义见 [NATIVE_V1.md](../../../NATIVE_V1.md)，完整自动对照见 [comparison.md](comparison.md)。

# PDFium 开发构建

在已同步依赖的 PDFium checkout 上构建本机补丁版 SDK，再用现有构建脚本生成隔离的原生助手。PDFium 提交和预编译 SDK 校验值见 [dependencies.json](../dependencies.json)。

在插件仓库根目录运行以下命令。需要把 Chromium 的 `depot_tools` 加到 `PATH`，并装好平台编译工具。

```sh
work="$(mktemp -d)"
revision="$(node -p 'require("./native/dependencies.json").pdfium.sourceRevision')"
git init "$work/pdfium"
git -C "$work/pdfium" fetch --depth 1 https://pdfium.googlesource.com/pdfium.git "$revision"
git -C "$work/pdfium" checkout --detach FETCH_HEAD
(
  cd "$work"
  gclient config --spec 'solutions = [{"name": "pdfium", "url": "https://pdfium.googlesource.com/pdfium.git", "managed": False, "custom_vars": {"checkout_configuration": "minimal"}}]'
  gclient sync --revision "pdfium@$revision"
)
```

SDK 从固定源码提交编译，版本和许可证清单取自同平台的锁定归档。补丁队列由 [patchset.json](patches/patchset.json) 和同目录的确定性转换脚本组成；它会生成 `DSH_PATCHSET` 摘要，Worker 构建会拒绝摘要不匹配的 SDK。运行 `node scripts/build-native.mjs --download-only` 准备归档和 JSON 头文件。也可以向 SDK 构建脚本传入 `--stock-archive` 指定已下载的归档。

```sh
node native/pdfium/build-pdfium-sdk.mjs --checkout "$work/pdfium" --sdk "$work/sdk"
DSH_PDFIUM_ROOT="$work/sdk" DSH_PDF_NATIVE_OUT="$work/worker" npm run native:build
```

macOS 使用完整 Xcode 时运行上面的命令。只有 Command Line Tools 时，在 SDK 构建命令末尾加 `--mac-clt`，脚本会从 `xcrun` 读取本机 SDK 信息，并在构建结束后还原 checkout 中的临时 GN 配置。构建产物缓存在 checkout 的 `out/dsh-sdk/`，重复构建可复用此目录，每次指定一个新的 SDK 目标目录。

```sh
DSH_PDF_NATIVE_HELPER="$work/worker/dsh-pdf-native" DSH_PDF_REQUIRE_NATIVE_TESTS=1 \
  node --import tsx --test tests/native-form-fields.test.ts tests/native-outline-extensions.test.ts tests/native-object-generations.test.ts
```

Windows 的助手文件名为 `dsh-pdf-native.exe`。每个平台包的 `manifest.json` 记录 `pdfiumSourceRevision`、`pdfiumPatchset` 和协议版本，供 Host 检查。

Linux ARM64 的 CI 在 Linux x64 主机交叉构建 PDFium SDK。同步源码前在 `.gclient` 中加入 `target_cpu = ["arm64"]`，构建时传入 `--target linux-arm64`。Worker 在 ARM64 runner 上编译并运行测试。

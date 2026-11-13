# DSH 兼容策略

本文说明插件如何声明、验证和更新对 DeepSeek Harness（DSH）运行时的依赖，目标是**DSH 发布补丁版本时不再因为版本枚举而禁用插件**，同时保留可验证的兼容边界。

## 准入契约

插件把 DSH 运行时版本写成一个区间：

```json
"engines": {
  "node": "^22.19.0 || >=24.0.0",
  "dsh": ">=0.2.2-rc.1 <0.3.0-0"
}
```

DSH 的 `evaluatePluginCompatibility` 规则是：**存在 `engines.dsh` 时只检查这一项，忽略 peerDependencies**。因此：

- `0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2`、`0.2.3` 都会被准入；
- `0.3.0-*` 和 `0.3.0` 不会（`<0.3.0-0` 排除 0.3 的预发布）；
- 不再为每个 DSH 补丁枚举一个精确版本。

peerDependencies 仍然保留给 npm/pnpm 解析，但使用 `^0.2.2-rc.1`，与 `engines.dsh` 同一兼容窗口，而不是精确版本列表。

## 为什么之前会每次更新都不兼容

旧 manifest 的 peerDependencies 是精确枚举：

```text
0.2.0-rc.1 || 0.2.0-rc.2 || ... || 0.2.2-rc.1
```

DSH 升到 `0.2.2-rc.2` 后，每个 `@deepseek-ai/dsh-*` peer 都不满足，兼容检查拒绝加载插件。实际上 API 没有整体重写，只是版本号越过了枚举范围。

## 开发依赖

`devDependencies` 固定为**当前验证过的 DSH 版本**（当前 `0.2.2-rc.2`），用于类型检查和测试。发布插件不会带上这些依赖；实际运行时由 DSH profile 提供。

更新 DSH 时：

1. 把所有 `@deepseek-ai/dsh-*` devDependencies 改成目标版本；
2. 把 `zod` 对齐到 `@deepseek-ai/dsh-storage-domain` 使用的版本（当前 `4.6.6`）。两套 zod 副本会让 `domainTable`/schema 类型不兼容；
3. 运行 `npm install`（仓库的 `.npmrc` 使用 `legacy-peer-deps`，因为 DSH 包内部的 peer 图很密）；
4. 运行 `npm run check`；
5. 只有确认新大版本可用后，才扩大 `engines.dsh`；不要把区间收紧回精确版本。

## 类型边界

- `@deepseek-ai/dsh-session` 的 `Session` 类型图很大，插件只观察 `session/disposed` 的 `{ id }`。该事件在 [session-events.ts](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/src/adapters/host/dsh/session-events.ts) 做**局部结构声明**，避免为了一个事件引入整个 session/agent 类型图，也减少内部类型漂移的影响。
- DSH 的 `ToolsService`、`DomainFacility`、`Subprocess` 等公开服务继续按类型使用；如果未来出现破坏性变更，类型检查会先失败。
- `@deepseek-ai/dsh-util-workspace-path` 是唯一运行时直接依赖的 DSH 包；使用 `^0.2.2-rc.1`，不锁定补丁。

## 验证

```sh
npm run check:dsh
```

它会检查：

- `package-lock.json` 的 `engines`、peer、dev 版本与 `package.json` 一致；
- 已安装的 DSH 运行时满足 `engines.dsh`；
- 所有 `@deepseek-ai/dsh-*` peer 范围接受当前运行时；
- 所有直接 DSH devDependencies 都是同一个运行时版本，防止 rc.1/rc.2 混装。

`npm run check` 已包含 `check:dsh`；`tests/dsh-version-compatibility.test.ts` 用真实 DSH 的 `evaluatePluginCompatibility` 再验证一次准入区间（接受 0.2.x，拒绝 0.3.0）。

## 已知限制

- `engines.dsh` 允许未来的 0.2.x 补丁；如果某个补丁实际上改了 API，类型检查/测试会在本地或 CI 先失败，但这需要开发者主动升级 devDependencies 才能看到。CI 固定 dev 版本，不自动追最新。
- 插件仍依赖 DSH 的若干内部包（tools、storage-domain、subprocess、attachment、settings/sidebar）。这些包的公开导出比内部实现稳定，但不是永久契约；升级时以 `npm run check` 和 E2E 为准。
- 版本区间不替代行为测试：运行时 API 的破坏性变化仍必须通过升级 devDependencies 后的类型检查和集成测试发现。

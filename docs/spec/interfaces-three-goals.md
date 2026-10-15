# 本轮公开接口约定

此文件固定供实现方与独立验证方使用的入口，不描述内部实现。

## Pipeline

- `node scripts/acceptance.mjs --list --json` 返回 `{ cases: [...] }`。
- Case 字段：`id`、`style: 'css' | 'less' | 'sass'`、`eslint: boolean`、`prettier: boolean`、`viteMajor: 5 | 6 | 7`。
- 执行参数：`--case <id>`、`--chrome <path>`、`--keep`、`--report <path>`。无 case 筛选为完整矩阵。
- 报告至少含 `status` 与 `cases`，每项有 `id`、`status`、`failedStage`、`stages: [{ name, status, command, exitCode }]`。
- 独立浏览器探针 `verifyExtensionInChrome({ dist, chrome, evidenceDir })` 由 Verifier 维护。
- 模板示例消息：`chrome.runtime.sendMessage({ type: 'PING' })` 返回 `{ pong: true }`。

`scripts/acceptance-core.mjs` 的可测试公开函数：

- `createMatrix(): Case[]`
- `parseArguments(args, environment = process.env)` 返回 `{ cases, chrome, keep, list, json, report?, selected }`；无效参数抛出可读 Error，`CHROME_PATH` 是 chrome 备用配置。
- `hashFile(filename): Promise<string>` 返回 SHA256。
- `identifyArtifact(directory): Promise<{ sha256, files: [{ path, sha256 }] }>`；路径相对目录、使用 POSIX 分隔符并稳定排序。
- `overallStatus(cases): 'PASS' | 'FAIL'`；仅非空且全 PASS 的集合返回 PASS。

## Doctor

`doctor.ts` 导出 `diagnoseExtension(options)`，options 为 `{ root?, dist?, devUrl?, cdp?, extensionId?, timeoutMs? }`，返回 Promise。

报告：

- `ok: boolean`
- `issues: [{ code, level: 'error' | 'warning', message, hint, field?, file? }]`
- `checks: [{ id, status: 'pass' | 'fail' | 'skipped', message }]`
- `permissions: { actual: string[], explicit: string[] | null, inferred: [{ permission, sources: [{ file, api }] }], autoPermissions: boolean | null, hostPermissions: string[] }`

无来源证据时不能把未知信息当作显式或自动推导事实。字段可向后兼容扩展。

## Content client

`@vite-react-chrome-extension/plugin/client` 导出：

```ts
defineContentScript(
  id: string,
  setup: (context: {
    data: Record<string, unknown>
    onDispose(callback: (data: Record<string, unknown>) => void | Promise<void>): void
    signal: AbortSignal
  }) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>,
): Promise<() => Promise<void>>
```

同一 runtime 内同 id 重挂载先清理旧实例，保留 data。清理函数幂等，旧实例的 stop 不应清理新实例。setup/cleanup 抛错时尽力执行剩余清理并 reject；signal abort，后续挂载可恢复。生产也支持基本挂载与显式清理。

供 Verifier 从输入/输出验证的 HMR 构建辅助接口（不属于包根导出的用户 API）：

- `content-hmr.ts` 导出 `prepareContentHmr(manifest, bundle, publicDir, emit, warn): ContentHmrEntry[]`。输入为 Manifest、Rollup 输出资源图及可选 public 目录；原地调整开发 Manifest，通过 `emit(fileName, source)` 输出本地注入文件。无法安全更新的条目发出 warning 并保留完整 reload 路径。
- `ContentHmrEntry` 包含 `id`、`js: string[]`、`css: string`、`hash`、`matches/excludeMatches/includeGlobs/excludeGlobs: string[]`、`world: 'ISOLATED' | 'MAIN'` 和 `allFrames: boolean`。
- `contentHmrRuntimeSource(entries): string` 返回可在 Chrome worker 环境执行的表达式，执行结果为 `(nextEntries) => Promise<void>` 更新函数；运行时依赖 `chrome.runtime`、`chrome.tabs` 和 `chrome.scripting`。可用可观察的浏览器 API 模拟验证行为，无需读取函数内部。
- `dev.ts` 的 `extensionReloadSnapshot(manifest, bundle, publicDir, managedContent?: Set<number>): string` 为注册/运行输入指纹；受管理的 content 独占资源变更不应改变该值，background、Manifest 注册字段或非受管理内容变化应改变。

以上辅助接口只固定可测试输入/输出，不允许据实现细节调整验收预期。与页面共享的运行输入修改仍按验收标准触发完整 reload；真实浏览器证据仍为独立条件。

# CASE-05：Background worker 与构建产物 verifier

## 目标

确保 Manifest 中声明的 service worker 在构建目录中可定位，并提供一个可用于模板和真实扩展项目的产物检查入口。

## 当前实现

插件继续支持两种 background 入口：

- TypeScript/模块入口由 Vite/Rollup input 编译，生成后由插件回写真实 chunk 文件名。
- `public/background.js` 可以作为普通 JavaScript worker 原样复制；不要和同名 Rollup 输出同时存在。

对于需要固定 worker 文件名的项目，可使用 `defineBackground`：

```ts
import { defineBackground } from '@vite-react-chrome-extension/plugin'

chromeExtension({
  background: defineBackground('src/background.ts'),
})
```

helper 会把 source entry 纳入 Vite/Rollup，默认产出 `background.js`，也支持
`{ fileName: 'worker.js' }`。显式 `manifest.background` 仍具有最终优先级；字符串
`background: 'background.js'` 与 `public/background.js` fallback 保持兼容。若项目显式
配置 `build.rollupOptions.output.entryFileNames`，该输出配置仍由项目负责。

根目录提供 `scripts/verify-extension-build.ts`，构建后检查：

- `manifest.json` 可解析且为 MV3；
- `name`、`version` 非空；
- popup/options/sidepanel/devtools、background、content script、icon 和 WAR 中声明的本地文件存在；
- WAR 中的 glob 和 `<dynamic_resource>` 占位符不会被误判。

运行方式：

```bash
npm run build:example
npm run verify:extension -- --dist examples/basic-extension/dist
npm run verify:extension -- --dist examples/basic-extension/dist --json
```

verifier 返回非零状态时可直接用于 CI。它不启动 Chrome；Chrome service worker 注册和 console/network 错误属于 CASE-10 的 CDP 验收范围。

CASE-05 focused checks:

```bash
npm run test:unit -- --run packages/vite-plugin-chrome-extension/test/plugin.vitest.ts
npm run typecheck --workspace @vite-react-chrome-extension/plugin
```

测试覆盖 helper 返回值、source entry 注入、稳定 `entryFileNames` 和生成 Manifest 的
`background.service_worker` 回写；verifier 与 CDP 仍分别检查最终磁盘文件和 Chrome
runtime 注册。

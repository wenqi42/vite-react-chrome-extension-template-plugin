# CASE-13：Framework-agnostic Vite fixture

状态：现有。plugin runtime 不要求 React、JSX 或 React-specific plugins。

## Fixture

`examples/vanilla-extension` 使用原生 DOM、TypeScript 和 Vite，包含：

- popup 页面；
- Manifest V3 module service worker；
- localhost content script；
- content CSS；
- 自动 WAR。

## 产物约定

- popup、background 和 content entry 都进入 Vite 输出；
- content script 没有顶层 ESM import/export；
- Manifest 的 content CSS 指向真实 stylesheet，而不是 Vite 的 synthetic JS facade；
- WAR 只包含 content script 实际需要的 JS/CSS 资源；
- plugin 不提供 framework runtime、Chrome API mock 或 content script HMR。

## 验证

```bash
npm run typecheck --workspace @example/vanilla-extension
npm run build --workspace @example/vanilla-extension
npm run verify:extension -- --dist examples/vanilla-extension/dist --json
```

verifier 应返回 `issues: []`。需要 Chrome runtime 证据时，再按 CASE-10 加载 unpacked extension，打开 popup、检查 worker，并在 localhost 页面确认 content marker 和 badge。

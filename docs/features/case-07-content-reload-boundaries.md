# CASE-07：Content script 开发更新边界

状态：content script 原地 HMR 尚未支持。当前路径是 watch build → 扩展 reload → 刷新宿主网页。

## 当前用法

```ts
chromeExtension({
  manifest: {
    content_scripts: [{
      matches: ['http://127.0.0.1/*'],
      js: ['src/content.ts'],
      world: 'ISOLATED',
    }],
  },
})
```

1. 启动 `vite dev`，在 Chrome 开发者模式加载 `dist`。
2. 打开匹配的宿主网页。
3. 修改 content script，等待开发构建成功。
4. 刷新宿主网页，新版本脚本会随导航执行。

扩展 reload 不会清理旧脚本已经对 DOM、事件监听器、计时器或全局对象产生的副作用。插件不会自动刷新所有用户网页，也不会向已打开文档重复注入脚本。

## World 边界

| World | 当前支持 | 未支持 |
| --- | --- | --- |
| `ISOLATED` | standalone IIFE、watch build、扩展 reload、宿主网页刷新后执行新版本 | 无宿主刷新模块替换、自动 dispose、状态恢复 |
| `MAIN` | 保留 Manifest `world` 字段和生产构建 fallback | 扩展 bridge、host CSP 下的 HMR、自动清理 |

MAIN world 与宿主页面共享 JavaScript 环境，host CSP 和页面脚本可能影响执行。不要把 build 成功描述为 MAIN world HMR 通过。

## 验证标准

当前 CDP smoke 会确认：扩展 reload 后旧宿主文档仍保持旧 marker；主动刷新宿主网页后得到新 marker，且没有 Runtime exception 或 `console.error`。这证明了可靠的 manual-host-refresh 路径，不代表 CRXJS 风格 content HMR。

后续 content HMR 需要独立实现和验证：可释放的更新机制、断线重连、重复注入保护、严格 host CSP、ISOLATED/MAIN 两种 world，以及无需手工宿主刷新即可观察新版本。

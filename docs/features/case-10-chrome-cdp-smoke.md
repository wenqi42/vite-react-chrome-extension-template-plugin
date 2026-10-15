# CASE-10：Chrome unpacked/CDP smoke

## 验收步骤

1. 运行项目 typecheck/build。
2. 使用 `npm run verify:extension -- --dist <dist>` 检查静态产物。
3. 在 Chrome `chrome://extensions` 开启开发者模式，加载同一 `dist` 目录。
4. 打开 popup/options，检查 Service Worker、Manifest 和控制台。
5. 打开匹配宿主网页，检查 content script、资源请求和页面错误。
6. 开发 reload 还需运行：

```bash
npm run test:dev-reload -- --chrome /path/to/chrome-for-testing
```

## 证据边界

静态 verifier 只检查 Manifest 和文件引用闭合。HTTP 预览不能证明扩展 runtime。CDP 验收需要明确 Chrome 版本、加载方式、页面/worker/content 上下文和观察到的异常；没有这些信息时，只报告静态构建通过。

开发 reload 还需要确认 Chrome Developer mode 已开启。页面自动刷新、整扩展 reload、worker 心跳和宿主网页刷新分别记录，避免将完整 reload 描述成状态保留 HMR。

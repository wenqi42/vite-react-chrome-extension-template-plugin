# CASE-06：扩展开发构建与自动 reload

状态：现有。该能力提供 build-backed full reload，不保留 React/Vue 组件状态，也不提供 content script 原地 HMR。

## 使用方式

```ts
import chromeExtension, { defineBackground } from '@vite-react-chrome-extension/plugin'

chromeExtension({
  background: defineBackground('src/background.ts'),
  liveReload: true,
})
```

运行 `vite dev` 或 `npm run dev`，等待首次构建成功，然后在 Chrome 开发者模式中加载 `build.outDir`（默认 `dist`）。`liveReload: false` 会关闭扩展 watch 和开发 client，只保留普通 Vite 预览。

## 行为

- 页面及其独占依赖变化：页面 client 调用 `location.reload()`，worker 保持运行。
- background、content script、Manifest 或共享依赖变化：worker 调用 `chrome.runtime.reload()`，Chrome 会关闭已有扩展页面，重新打开后即可使用新版本。
- 构建先写入独立暂存目录。编译、写盘和后置插件全部成功后，才原子替换最终输出并发送 revision。
- 语法错误、晚期构建错误和删除仍被引用的 public 文件不会改动最后成功的输出，也不会触发 reload。
- worker 每 20 秒发送 WebSocket 心跳，支持 Chrome 116+ 的 MV3 worker 生命周期。
- 同一 host/port 的 Vite 重启会重连并同步新 session；地址或端口变化需要重新加载开发扩展。

开发 Manifest 会临时加入开发服务器 host permission 和 CSP `connect-src`。正式 `vite build` 不包含开发 client、开发 worker、开发 host permission 或开发 CSP。

## 运行时边界

- 这是完整 reload，不是状态保留 HMR。
- 已注入的 content script 不会自动重新执行；修改后刷新匹配的宿主网页。
- `world: 'MAIN'` 继续使用生产构建 fallback，不代表 MAIN world HMR 已支持。
- 工具栏 popup 属于短生命周期页面，整扩展 reload 后需要重新打开。
- Chrome 开发者模式必须开启；命令行首次加载不等于 `runtime.reload()` 权限已验证。

## 验证

```bash
npm run test:dev-reload -- --chrome /path/to/chrome-for-testing
```

脚本使用独立 Chrome profile 和 CDP 检查：首次构建、页面刷新、整扩展重载、worker 空闲心跳、content host 刷新、失败构建保护、错误恢复、同地址重启、production 隔离和 `liveReload:false`。脚本成功退出且 `errors` 为空才算通过。

另外，`packages/vite-plugin-chrome-extension/test/dev.integration.vitest.ts` 覆盖 staging 发布、public worker、删除引用、后置构建错误和原子回滚。

# CASE-14：Network rewrite sidebar

状态：构建、产物检查、15 项示例回归和独立 Chrome/CDP 20 项运行时检查通过；契约见[验收标准](../spec/acceptance/network-rewrite.md)。

## 示例位置

`examples/network-rewrite-extension` 使用本仓库插件构建一个 Chrome MV3 side panel：

- side panel 管理规则；
- 用户主动附加当前标签页；
- background 使用 `chrome.debugger` 的 Fetch 域在响应阶段暂停请求；
- header 规则返回新的 `{ name, value }[]`；
- body 规则在 offscreen document 的 sandbox iframe 中执行；
- 脚本返回字符串，或返回 `{ body, headers }`；
- 规则保存到 `chrome.storage.local`。

## 构建

```bash
npm run build:network-example
npm run verify:extension -- --dist examples/network-rewrite-extension/dist --json
npm test --workspace @example/network-rewrite-extension
npm run test:network-rewrite -- --chrome /path/to/chrome-for-testing --headed --keep
```

在 Chrome `chrome://extensions` 开启开发者模式并加载 `examples/network-rewrite-extension/dist`。打开需要调试的 HTTP/HTTPS 网页，点击扩展图标打开侧栏。

1. 点击 `Attach active tab`，确认显示 `Attached: ...`。
2. 添加规则，填写 URL contains、资源类型和改写脚本，点击 `Save rules`。
3. 重新发起请求或刷新目标网页，检查页面实际收到的响应。

`No tab attached` 表示尚未拦截。保存规则不会自动附加；已经完成的请求不会被追溯修改。URL contains 是区分大小写的子串匹配，资源类型使用 `Fetch`、`XHR`、`Document` 等名称；留空匹配所有类型。

侧栏显示命中、成功改写和失败次数，以及最近一次脚本错误。状态刷新不会覆盖未保存的编辑内容。Chrome 主动断开 debugger 后，侧栏会显示未附加。

## 脚本输入

脚本可以读取：

- `body`：响应文本；
- `headers`：`{ name, value }[]`；
- `request`：`url`、`resourceType`、`statusCode`。

例如：

```js
return body.replaceAll('old text', 'new text')
```

```js
return headers.filter(header => header.name.toLowerCase() !== 'x-remove-me')
```

## 安全和平台边界

- 只处理用户主动附加的单个标签页；`debugger`、`tabs` 和 HTTP/HTTPS host permissions 会显示高权限警告。
- 用户脚本运行在 Manifest sandbox iframe 中，不拥有 `chrome.*` API，可返回 Promise 或使用 `await`。脚本抛错或异步等待超过 5 秒会继续原始响应；同步无限循环不在超时恢复保证内。
- Body 脚本支持 UTF-8 文本、JSON（含 `+json`）、XML 和 JavaScript 等文本响应。只改 header 时需清空 Body script，二进制正文保留原始字节。重新构造响应会移除旧的长度和传输编码 header，避免已解码正文再次解压。
- HEAD、重定向、204/205/304 和网络失败响应直接放行。跨进程子 frame、流式下载、WebSocket 和缓存/Service Worker 特殊链路不在保证范围内。
- Chrome 内置页面、扩展页面和受限制的浏览器页面不能作为普通网页拦截。
- 这是开发和调试示例，不是隐形代理、隐私过滤器或 Chrome Web Store 审核保证。
- side panel 关闭或切换标签页不会自动分离 debugger，使用 Detach 按钮结束当前标签页会话。Chrome DevTools 或其他调试工具可能与调试连接冲突。

## 运行时验证范围

CDP 验收在独立 Chrome for Testing 配置中加载构建产物，确认真实 `SIDE_PANEL`、worker、offscreen document 和 sandbox iframe 上下文，并断言页面实际收到的 Fetch/XHR 响应，包括：

- Header 新增、修改、删除，UTF-8 文本、JSON、异步脚本和 gzip 响应改写；
- 不匹配及禁用规则放行，Header-only 二进制字节保真；
- 脚本异常和异步超时回退、204/重定向请求不阻塞；
- Detach 恢复原始响应，关闭标签页更新状态且保留未保存输入，规则持久化。

脚本以真实鼠标手势打开侧栏，确认 `openPanelOnActionClick: true`；未自动点击 Chrome 原生工具栏图标。规则持久化检查通过重新加载侧栏页面完成。`--keep` 保留运行报告与截图。无 popup 的 action 构建另有插件回归检查。

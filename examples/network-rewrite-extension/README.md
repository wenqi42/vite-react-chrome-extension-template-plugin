# Network Rewrite Sidebar

这是一个基于 `@vite-react-chrome-extension/plugin` 的 Chrome MV3 示例：

- 使用 `sidePanel` 提供规则编辑界面；
- 由用户主动把 debugger 附加到当前标签页；
- 通过 Chrome DevTools Protocol `Fetch` 在响应阶段暂停请求；
- 支持修改响应 header；
- 支持在 sandbox iframe 中运行用户提供的 JavaScript，返回新的 body 或 `{ body, headers }`。

## 运行

```bash
npm install
npm run build
```

在 Chrome `chrome://extensions` 开启开发者模式，加载 `dist`。打开一个普通 HTTP/HTTPS 网页，点击扩展图标打开 side panel：

1. 点击 `Add rule`，填写 `URL contains` 和脚本。资源类型留空匹配所有类型，或填写 `Fetch, XHR`。
2. 点击 `Save rules` 保存；保存本身不会启动拦截。
3. 点击 `Attach active tab`，确认侧栏显示 `Attached: ...`。
4. 刷新网页或重新触发请求。只有附加后发起的请求会生效。

侧栏显示命中、成功改写和失败次数。`Matched 0` 表示还没有请求命中规则；脚本失败会显示最近错误。关闭再打开侧栏会恢复保存的规则，后台状态刷新不会覆盖编辑器中未保存的输入。点击 `Detach` 停止拦截。

示例 body script：

```js
return body.replaceAll('old text', 'new text')
```

示例 header script：

```js
return [
  ...headers.filter(header => !['x-remove-me', 'x-debug'].includes(header.name.toLowerCase())),
  { name: 'x-debug', value: 'rewritten' },
]
```

脚本可以读取：

- `body`：响应文本；
- `headers`：`{ name, value }[]`；
- `request`：`url`、`resourceType`、`statusCode`。

body script 可以返回字符串，也可以返回：

```js
return {
  body: body.replace('old', 'new'),
  headers: [...headers, { name: 'x-rewritten', value: '1' }],
}
```

## 设计边界

扩展使用 `debugger`、`tabs`、`offscreen`、`storage`、`sidePanel` 权限及 HTTP/HTTPS 站点访问权限。Chrome 会显示调试连接警告，用户必须主动附加。受限制页面无法附加；Chrome DevTools 或其他调试工具可能与此连接冲突。

body 脚本运行在 Manifest sandbox iframe 中，不拥有 `chrome.*` API；支持返回 Promise 或使用 `await`。脚本抛错或异步执行超过 5 秒会继续原始响应并显示错误。请勿运行不可信脚本：同步无限循环不在超时恢复保证内，可能需要重新加载扩展。

body 改写支持 UTF-8 文本、JSON（含 `+json`）、XML、JavaScript 等文本响应。只修改 header 时请将 body script 清空，二进制正文会保留原始字节。重新构造响应时移除旧的长度和传输编码 header，防止已解码的正文再次解压。HEAD、重定向、204/205/304 和网络失败响应直接放行。

附加仅针对选中的标签页；切换标签页不会转移或结束已有连接。关闭 side panel 也不会自动分离。点击 `Detach`、关闭已附加标签页，或 Chrome 主动结束调试连接后停止拦截。跨进程子 frame、流式下载、WebSocket 和缓存/Service Worker 特殊链路不在保证范围内。

回归检查从仓库根目录运行：

```bash
npm test --workspace @example/network-rewrite-extension
npm run build:network-example
npm run verify:extension -- --dist examples/network-rewrite-extension/dist --json
```

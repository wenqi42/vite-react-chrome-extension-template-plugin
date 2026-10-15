# CASE-07：Content script 原地更新与生命周期

默认开发行为仍为扩展完整 reload，已注入的 content script 需要刷新宿主网页后执行新版本。需要原地更新时，显式开启 HMR，并使用生命周期 API 管理脚本副作用。独立验收状态见 [能力矩阵](../acceptance-matrix.md)。

## 启用

```ts
chromeExtension({
  contentScripts: { hmr: true },
  manifest: {
    content_scripts: [{
      matches: ['https://example.com/*'],
      js: ['src/content.ts'],
      world: 'ISOLATED',
    }],
  },
})
```

`src/content.ts`：

```ts
import { defineContentScript } from '@vite-react-chrome-extension/plugin/client'
import './content.css'

void defineContentScript('example-editor', ({ data, signal, onDispose }) => {
  const root = document.createElement('section')
  const input = document.createElement('input')
  input.value = typeof data.draft === 'string' ? data.draft : ''
  root.append(input)
  document.body.append(root)

  input.addEventListener('change', () => {
    console.log(input.value)
  }, { signal })

  onDispose(previous => {
    previous.draft = input.value
    root.remove()
  })
})
```

为每个逻辑脚本使用稳定且独立的 ID。同一个执行 world 中，同 ID 的下一次挂载会先等待旧实例完成清理，再获得相同 `data` 对象。`signal` 在清理时 abort；也可以返回同步或异步清理函数，显式清理 DOM、定时器和订阅。

`defineContentScript` 返回清理函数的 Promise。停止操作幂等，旧实例的停止函数不会清理新实例。setup 或 cleanup 失败时尽力完成剩余清理并 reject，调用者可捕获错误；之后允许重新挂载。生命周期 API 在生产中仍可使用，不依赖 Chrome API 或开发服务。

## 更新行为

- ISOLATED 和 MAIN 分别拥有自己的生命周期数据，不跨 world 共享。
- 受支持 content script 或其独占依赖更新时，worker 向匹配文档注入打包在扩展内的本地脚本，宿主无需导航。
- CSS 更新通过 Chrome 的样式注入接口移除旧文本并加入新文本；开发初始样式由异步 bridge 注入，不能依赖它在网页首帧之前出现。
- 多个匹配标签页同步更新；新开匹配网页执行当前产物；不匹配文档不会挂载。
- 构建失败保留最后成功版本；修复后继续更新。
- 同地址开发服务重启后重连；扩展页面可能因开发 session 切换刷新。随后纯 content 更新仍保持宿主、worker 和无关扩展页面运行。
- background、Manifest 注册字段或与其他运行入口共享的依赖改变时，使用完整扩展 reload。

开发代码不从 Vite 加载远程 JavaScript，也不依赖 eval；WebSocket 传递更新信息。CSS 注入不依赖宿主允许内联 style。MAIN 与宿主共享 JavaScript 环境，使用者仍需避免全局命名与页面逻辑冲突。

## 限制与回退

HMR 需要源码实际调用生命周期注册。插件不能自动推断任意脚本的 DOM、监听器和定时器清理，也不会自动序列化框架状态；React/Vue Fast Refresh 不在此接口的保证范围内。

不兼容条目会发出诊断并保留完整 reload 路径，例如未注册生命周期的 JavaScript、非 standalone 的模块输出，以及 `match_about_blank` / `match_origin_as_fallback` 等不能安全复现的匹配方式。完整 reload 不会清理已注入脚本对旧宿主文档的影响；此时刷新匹配宿主网页。不要用宿主刷新作为原地 HMR 的成功证据。

`liveReload: false` 关闭整个开发更新层。开发 Manifest 为原地注入增加 `scripting` 和匹配 host 权限，以及开发连接需要的 host permission/CSP。生产构建不包含传输客户端、开发地址或这些开发新增权限；用户显式声明的权限继续保留。

## 验证

```bash
npx vitest run packages/vite-plugin-chrome-extension/test/content-hmr.vitest.ts
npm run test:content-hmr -- --chrome /path/to/chrome-for-testing
npm run test:coverage
```

真实浏览器检查两个 world、三次更新、输入恢复、DOM/监听器/定时器清理、CSS、多标签页、严格 CSP、错误恢复、重连和完整 reload 回退。打包后还需外部项目类型检查、生产构建和基本挂载/清理验证。完整条件见 [HMR 验收标准](../spec/acceptance/content-hmr.md)。

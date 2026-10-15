# Content Script 原地 HMR

验证路径：A。生命周期、状态转移、更新判定先由独立 Verifier 建立失败用例；浏览器先按以下步骤定义可观察断言。

## 范围与所有权

Implementer 负责插件 `dev.ts`、content runtime/lifecycle 模块、必要的 index.ts 接入和 client 子路径打包。原有源码编译、生产 IIFE、资源图、AST 权限推导保持。

Verifier 负责生命周期用例、Playwright/Chrome fixture、浏览器探针与覆盖率配置。公开文档与能力矩阵由 Orchestrator 维护。

## 公开契约

1. `contentScripts: { hmr: true }` 为显式启用入口；`liveReload: false` 关闭开发层。未启用或不兼容的旧项目保留现有 reload 行为。
2. 提供浏览器可导入的 `@vite-react-chrome-extension/plugin/client`，通过 `defineContentScript` 注册挂载与清理生命周期。上下文提供可保留的 `data`、`onDispose` 与 `signal`；支持返回清理函数。接口有类型声明，生产构建正常挂载。
3. 生命周期接口使使用者能在清理时保存输入等数据，在下一次挂载时恢复；不承诺对任意页面状态自动序列化或框架 Fast Refresh。

## 运行时验收

1. ISOLATED 与 MAIN 两个 world 分别验证：修改 content JS/TS 或其独占依赖后，已打开宿主网页无需导航或刷新就呈现新版本，背景 worker 和无关扩展页面不重启。
2. 连续至少三次更新，DOM 只有一份 UI；监听器、计时器与旧挂载已清理，单次操作只触发一次响应。输入值通过生命周期 data 保留，宿主自己的页面状态保持。
3. CSS 独立变更原地生效，不重载宿主或 background，不重复堆叠样式；JS 与 CSS 联合变化也正常。
4. 验证新开匹配标签页、多个已开标签页、明确不匹配标签页，以及重复/延迟更新的去重。只有匹配且适用的文档更新。
5. 语法错误保持最后成功版本且无更新通知；修复后恢复。开发服务同地址重启可重新连接，关闭服务清理 watcher/临时资源。
6. 严格 host CSP 下分别验证两个 world，不从开发服务器加载扩展远程 JavaScript，不使用 eval 绕过 MV3 CSP。
7. background/Manifest/共享运行输入变更按既有契约 full reload；不支持的条目有明确诊断与回退边界，不能以宿主刷新冒充原地 HMR。
8. 生产产物不含 HMR 传输客户端、开发 endpoint、开发 host permission、开发 scripting 权限或开发 CSP。用户显式权限仍保留。生命周期的基本挂载/清理接口可正常打包使用。
9. npm pack 后的 client 导出可被外部项目实际构建与类型检查，包不将 Node 专用模块带入浏览器。
10. 全仓 lint/typecheck/tests 和核心覆盖率 >90% 通过，原有 reload 与 Network Rewrite 回归不新增失败；Chrome/Playwright 证据绑定最终产物并包含版本、上下文、导航次数和异常记录。

失败标准：只更新 dist 而原页面不变；刷新网页或整扩展来完成纯 content 更新；重复 DOM/事件；丢失显式保留的数据；MAIN 仅构建而不运行验证；生产残留开发权限或传输代码。

# Web 加载与交互性能

本文面向维护 Host 静态资源和浏览器读面的开发者。目标是在既有浏览器 → Host → 项目 daemon 架构内减少下载、无效读取和重绘，不引入桌面客户端或新的后台事实来源。模块入口见 [Web 地图](modules-web.md)，取舍遵循[工作台设计](../design/workbench.md)和[执行过程设计](../design/agent-process.md)。

## 首屏资源

- 源码仍采用原生 ES module；`static-assets.js` 在进程首次使用时固定源码内容版本，启动独立 Bun 子构建，并复用内存产物。`startWeb()` 保持同步调用契约；子构建固定当前 Bun、无 shell 插值，超时 60 秒，失败保留诊断且清理临时构建目录。
- `build-assets.js` 使用 Bun 内置 `build`，压缩入口、拆分共享块和动态页面，不添加第三方运行时依赖或要求用户手动执行构建步骤。
- HTML 只引用内容版本 URL；仅预加载实际静态依赖闭包，不提前拉取动态页面。设置、Agent 配置、版本、输入历史和模型来源等入口动态加载。模块加载与导航/boot 代次绑定，迟到结果不得覆盖新页面。
- 首屏 CSS 合为一个文件，展开原有 CSS import 并保持级联次序；本期不是逐页面懒加载全部 CSS。自动化的部分实现仍被详情/Worker 图共享，不能把动态入口当成其全部代码已退出首屏。
- gzip 在产物装载时生成，不逐请求压缩；按 `Accept-Encoding`（含 q 值）协商，设置 `Vary`，不支持可接受的表示时返回 406。

## 缓存与访问安全

内容版本 JS/CSS 使用 `private, max-age=31536000, immutable`。每种编码有独立 ETag，认证后的条件 GET 支持 304，使携带验证器的条件请求也可复用正文。HTML、项目 API、旧源码 basename 与失败响应仍 `no-store`；不把项目状态或凭证放入静态产物。Firefox 在 HTTP 下的主动刷新可能重新验证，不能把普通再次访问的零传输当成所有刷新都零请求。

Host 身份、登录、Origin 和路径白名单校验在静态资源/304 响应前执行；不放宽 CSP，不引入 Service Worker 或匿名资源端点。旧 HTML 仍可访问旧源码 basename；已版本化的旧 URL 则只返回对应产物，不能映射到新版本代码。

公开静态产物快照保存在用户私有临时缓存 `lush-web-assets-<uid>`，目录 0700、档案 0600。最多装载/保留三代，每代档案与解码内容均受 32 MiB 限额约束；装载核对名称、版本、内容摘要、所有者、权限及 symlink。淘汰的旧 URL 返回 404，动态入口提示刷新重试。缓存可重建，不属于项目事实或数据库迁移，也不进入 Git；源码/构建器/Bun 版本变化会生成新资源版本。

缓存命中不等于登录授权，浏览器仍可能持有已下载的静态代码；它不包含登录后的项目数据。Host 重启、登录会话和项目后台仍遵循[工作台接入契约](workbench.md)。

## 轮询与局部重绘

`app.boot()` 持有 `initRefreshPolling()` 的 dispose：重复 boot 先释放旧会话和监听，使其在途结果失效，再装配当前项目。默认隐藏页面不自动读取概览或实时正文；用户已开启且获授权的系统通知例外，保留有界概览轮询以继续提醒，但暂停详情/Git/正文读取，不偷偷申请权限。恢复可见立即尝试概览和记录读取，不让慢概览阻塞记录。无项目工作台不装配项目轮询。

健康可见页面沿用用户设置的刷新间隔，失败才按 1.5 秒起步、最多 30 秒退避。`refresh()` 是定时器入口；导航注册强制刷新包装，用户操作 ACK 和切回概览不受隐藏/退避限制。在途概览后的多个 ACK 合并为一次后续读取，而不是被忙碌锁静默丢弃。不重试未知结果的写操作。

Worker 列表按 ID 复用节点，仅更新变化的显示字段。依赖包括状态、展示标题、父子等待原因、依赖编号、配置的进度开关和进度投影，而不只比较 `updated_at`。相对时间和已执行时长独立补丁；排序/筛选仍沿用现有规则，保留幸存节点的焦点、选区和语义引用。分页请求与项目/boot 身份绑定，并合并当前快照，避免旧响应覆盖新状态。

实时 usage 与记录读取独立 single-flight；慢用量不拖正文，失败不丢成功记录。发布前核对项目、页面、Worker、缓存和游标，去重并保持游标单调。已打开记录的终态尾读只在成功接受最后一页后标记完成；竞争丢弃响应或仍有后页不能标记完成。正文仍增量追加，不改写原记录或自动打开阅读器。

## Worker 详情

核心 inspect 是首个请求；成功绘制后即可返回给告知已读 ACK，不等补充内容。随后读取历史，仅有调用记录时读取用量。改动概览必须显式打开才读 diff；同 Worker 刷新保留该展开状态，加载/失败状态与旧内容分别可辨。

连接名称缓存只保留最多 1000 个公开 `id/label`，30 秒 TTL、单飞、内存存储，按项目和 boot 身份隔离。相关成功配置/连接 action 后失效，在途旧读也失效；失败不回退为假装新鲜的旧事实。它不是账号/额度/配置缓存，不保存秘密或磁盘副本。

详情离页经统一导航回调取消 HTTP 只读请求，boot 也显式清理；取消只是停止等待/接收，不保证已进入 daemon 的服务端工作被取消。不取消 Worker/模型/写操作。迟到结果仍必须通过页面身份检查，详情补丁保留原有焦点、选区、手动展开和阅读位置保护。详见[阅读器](transcript-reader.md#worker-详情渐进加载)。

## 验证与测量边界

```bash
bun run test --timeout 30000
bun run check:workbench
bun run scripts/check-input-history-ui.js
bun run test/web/check-progress-history-browser.js
bun run measure:read-performance --samples 5
bun run docs:check
```

测试使用临时项目、受控进程或本地 fixture，不重启用户 Host/daemon，不连接真实账号或调用模型。

- `loading-assets.test.js`：源码/产物静态依赖闭包、拆包与 modulepreload、CSS 次序、gzip/ETag、登录与项目路由、旧代/淘汰、缓存权限与路径拒绝。
- `dom-built-loading-assets.test.js`：实际 Bun 浏览器产物的共享状态、懒页面和重复 boot；`dom-loading-assets.test.js`：导航/boot 竞态。
- `dom-refresh-performance.test.js` / `live-performance.test.js`：节点复用、隐藏/恢复、退避/ACK、分页/尾读/慢统计竞争。
- `detail-request-cache.test.js` / `dom-detail-requests.test.js` / `dom-detail-tail.test.js` / `detail-requests-api.test.js`：核心优先、显式 diff、标签失效/隔离、只读取消、终态尾部与真实 HTTP 请求组合。
- `dom-web-performance-integration.test.js`：真实 boot 与轮询/详情生命周期组合。
- `check:workbench`：实际 Host + Firefox，记录首屏静态传输、普通再次访问的缓存收益和 WebDriver 主动刷新是否发送验证器，检查拆包、全局导航、独立项目标签及双主题响应式。
- 输入与规划历史浏览器脚本：真实键盘/原生展开/焦点、慢读取下 ACK、分页和阅读位置保护；这些是本机回环测试，不是远端链路测速。

`measure:read-performance` 检查不同规模临时数据的有界概览/日志读取预算和 DOM stub 渲染，不覆盖浏览器布局或网络。不能用它证明用户远端首屏或交互已加速；实际服务仍需测冷/热加载、API TTFB、长任务和输入响应，并明确区分网络往返与浏览器渲染成本。

本期不引入 WebSocket/SSE、虚拟列表或长记录窗口化；已有分页、正文预览和增量读取保留。若未来测量显示长记录 DOM/高亮成为主因，再针对可见内容分批处理，不以删掉全文搜索、原文或引用定位换取速度。

[返回工程索引](README.md) · [Web 模块](modules-web.md)

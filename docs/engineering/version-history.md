# Worker 详情中的版本迭代

版本迭代是 Worker 详情「代码与提交」旁的只读模块，不再有独立版本页。order／child 详情直接显示历史交付轮次迭代图，main 详情显示 main Git 提交图；Valet 详情只保留管理绑定与收据，不显示 Git 或 Web 配置入口。旧 `#versions` 导航由页面路由重定向到 main Worker 详情。公共字段、权限、快照和大小限制统一见[Worker 版本读面](../reference/rpc/branches.md#worker-详情版本读面)。

## 默认范围与按需读取

- 非 main 默认读取该 Worker 的持久成功交付 Event，按 Event ID 倒序直接显示轮次节点与先后连线，不读取当前分支。每个节点突出 Event 身份、时间及可追溯状态；连线是交付先后，不是 Git parents。没有成功交付明确显示空状态，分支有提交也不冒充交付历史；旧成功 Event 缺证据仍显示节点与原因。main Worker 仍读取 main 完整可达 Git 图。
- 模块默认紧凑可见，但只在 `IntersectionObserver` 确认滚入模块时读取第一页；不支持观察器时提供键盘可达的「加载交付轮次」（main 为「加载版本图」），不会自动读取。Git 不阻塞详情主体或与主 inspect 竞争。
- 每页最多 30 节点，「较新版本／较早版本」替换当前页，不追加完整图。全模块最多缓存三个图页（跨范围共享上限），其中 main 图首屏固定保留，避免返回第一页时重新取样可变 ref；其它淘汰页只留轻量 cursor 与图身份，返回时按固定 cursor 重读。固定交付首屏没有 offset-zero cursor，淘汰后仅可重新取样同一 Event／tip／base，并清除该图旧 snapshot 和 cursor，不混用签名。分页不混入取样之后的提交。
- 轮次图随模块滚入直接读取第一页，无需展开选择器或切换图；每页最多 30 轮，较新／较早切换替换正文，仅保留一页轮次与轻量 keyset 游标。刷新从最新轮次重新读取；读取失败保留最后成功页，不显示为空历史。节点按成功 Event ID 区分，即使源／落点 SHA 相同也不合并为一轮，不使用 Worker ID 或预约编号。点击轮次才在模块内展示该 Event 的固定提交图与 tip／开发基线，可返回轮次图，不回退当前分支。
- 点击节点才用该图的 `snapshot + 完整 SHA` 读取一个提交详情，内联展示完整 message、SHA、作者、关联 Worker 目标和可折叠原始 Input。一次只保留一个节点详情，不预取所有目标或 Input；正文全部是安全文本。

## 图语义与追溯

按需提交图中的节点是实际提交，泳道线条来自真实 `parents`，不是相邻记录或 Worker 委派关系；默认轮次图则以成功 Event 为节点，只表示交付先后。虚线说明父提交在本页之外（较新页、未读页或范围外），可展开边界 SHA；每页保留固定 tip／开发基线说明。

关联以完整落地 SHA 与成功 Event 的明确父目标为证据，不按标题、时间或当前 Worker HEAD 猜测。已知编号使用持久 `worker_number`；未知只显示 `#内部ID`。每条关联保留真实 `<a href="#worker-ID">`，支持原生导航、新标签与已有 Worker 简介帮助。

main 提交图中的子 Worker 只保留真实详情链接，不在 main 模块内展开子交付图；到该 Worker 详情即可直接看到其轮次迭代图。非 main 的按需提交详情中，只有节点明确 `delivery_available:true`、正整数成功 Event ID 和交付 Event 证据时，才显示固定子交付图入口。该入口读取**对应子 Worker**的固定交付图，可返回上层；普通 `worker.source`／`delivery.source` 没有独立交付 Event，不递归打开自己。历史证据不足或 Git 对象缺失明确失败，不改看子 Worker 当前分支。

固定交付图排除本轮父侧已有提交，保留同步提交的真实 parents。旧单源 Squash 与 v3 多源归并分别按后端的持久凭据核验，不拿可变 reservation／iteration 基线替代。精确算法与兼容协议由 RPC 契约维护；旧 `branch.history`／`branch.version_graph` 读协议仍保留，但不再是详情模块入口，游标不能混用。

## 生命周期与失败

图／分页／轮次／节点读取都显示加载、失败与重试；失败保留最后成功的图页或轮次页，不冒充空历史。显式图刷新取消旧请求、清除当前图 snapshot 与页缓存，再读第一页；刷新失败时保留旧图供阅读，但不再用旧 snapshot 读取节点。

界面轮次提交详情从第一页起显式指定 delivery，后续页保持该 Event 身份；后端兼容的默认当前图／归档 fallback 读协议不变，但不再是非 main 模块的默认入口。切换 Worker、图、刷新、项目、document 或离页后，迟到响应不得覆盖新页面。离页取消请求并释放 observer 和控件处理器；同 Worker 的常规详情重绘复用整个版本模块及其独立生命周期，不因详情自动轮询重读、重建版本图。跨图缓存只保存有界页数据，节点详情在切图／切页时关闭。

## 实现与验证

模块入口为 `src/ui/web/assets/render-versions.js`，由 `render-detail.js` 接入，`detail.js` 负责导航离页清理；泳道计算在 `version-graph-layout.js`，专用布局在 `styles-versions.css`，不套普通长文本预览裁切。旧书签路由由 `retired-pages.js` 从有界 overview 定位真实 main Worker 并跳其详情；独立页渲染入口已删除，不猜测 main 的整数 ID。

- `bun run test test/web/dom-versions.test.js test/web/version-graph-layout.test.js`：滚入直接展示持久轮次、无交付／缺证据状态、不读当前分支、30 轮分页与重试、main 仅子 Worker 链接、固定提交图 30 节点与三页缓存、节点按需详情、迟到隔离、同 Worker 重绘和离页释放。
- `bun run scripts/check-versions-layout.js [截图目录]`：Firefox／geckodriver + 临时项目的真实 Web → RPC → Project → SQLite/Git，覆盖详情→直接显示两轮持久交付→按需固定提交图→分页与缓存返回→按需提交详情→固定子交付图→原生子 Worker 详情链接，以及 main 仅链接、未交付分支空历史、双主题与窄屏。顶层实际页面检查 1440／900／500px；因 Firefox 顶层最小窗口限制，390px 使用真实窄 iframe 的生产 DOM/CSS 克隆做模块几何检查（不是新一次交互链路）。脚本清理自有服务、浏览器与临时项目，保留截图、读取证据和日志，不操作用户服务或调用模型。

跨列表／详情、旧 hash 重定向与导航文案的最终集成需在所有前端成果汇齐后的代码树验证；专项浏览器脚本不替代顶层全量责任。

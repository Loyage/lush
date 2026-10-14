# Worker 详情中的版本迭代

版本迭代是 Worker 详情「代码与提交」旁的只读模块。order／child 默认直接显示从父侧创建节点引出的双轨提交历程，而不是交付轮次列表；main 保留真实 Git 提交图。Valet 不显示 Git 模块；旧 `#versions` 书签仍转到真实 main Worker 详情。字段、权限、可信范围及预算统一见[Worker 版本读面](../reference/rpc/branches.md#worker-详情版本读面)。

## 默认信息与图语义

- 左轨是直接父 Worker，右轨是当前 Worker；段内从上到下旧到新。创建时的 origin 单独作为父侧引出锚点，右轨显示创建以来的 first-parent 来源提交，包含此前交付过的开发和当前尚未交付的已提交开发。未提交工作区不在图中。
- Worker commit 与真实 Git 父边清晰显示；父侧引出点、交付落点低饱和显示，但文字保持可读。父侧引出点之前、引出点与交付落点之间的外部历史不铺开，用虚线省略。同步 merge 自身保留，真实第二父边可见；外部父提交不冒充本 Worker 的开发。
- 交付依据持久成功 Event，把固定 source SHA 映射到父侧 landing SHA；独立点线与收据标明“不是 Git parents”。相同 source／landing 的多个 Event 合用一条映射线但保留每个 Event；共享 landing 只造一个父侧锚点，每个不同来源仍连到该锚点。同源多个落点、无新落点及落点等于 origin 都保留对应映射，不造重复提交。
- 默认显示短 SHA、摘要、提交时间与 Worker 链接，交付摘要直接标出 source → landing。完整收据、SHA、消息、作者、Worker 目标及原始 Input 按需展开；一次仅保留一个来源／origin 节点详情。父侧落点仅展开映射收据，不通过来源接口读取任意 Git 对象。
- 缺少或核验失败的证据保留 Event 和原因，不画可信交付线，不根据标题、时间、当前 HEAD 或可变预约猜节点。无开发仍显示引出点；无交付但有 commit 正常显示来源链。回收后的分支只按可靠固定源恢复，不跳过损坏的最新成功证据。
- main 图按真实 `parents` 显示可达历史，不改成 Worker 委派树。main 与来源图的子 Worker 关联均为原生详情链接，到对应 Worker 看其完整来源链；不在模块内递归展开旧固定交付图。已知编号用持久 `worker_number`，未知才回退 `#内部ID`。

## 有界读取、分页与生命周期

模块滚入时才读取第一页，不阻塞 Worker 详情主体；没有 `IntersectionObserver` 时使用键盘可达的「加载来源图／加载版本图」，不自动读取或轮询。

来源图每段最多 30 个自身提交，先读最新段、段内倒序呈现；创建锚点持续可见，但与未读的更早范围之间明确显示省略，不能实线跨过缺口。「较早版本／较新版本」替换整段，不累计全图。首屏取样固定 tip、origin、父身份和 Event 高水位；后续段及详情保持同一签名快照，不混入新提交或新交付。main 使用自己的 graph 快照，旧读协议保持兼容。

最多缓存三个页，固定保留首屏以免返回时重新取样可变 ref；淘汰段仅保留轻量 cursor。刷新清除旧签名、缓存和节点详情，重新取样。读取失败保留最后成功页及重试入口，不冒充空历史；刷新失败后不得再以旧签名读取节点。

切 Worker、项目、document、图页、刷新或离页取消／隔离迟到请求。同 Worker 的常规详情重绘复用模块、展开状态与独立生命周期，不重新读取 Git。交付线按实际来源／落点标记坐标计算，节点或收据展开、视口变化后重新测量；离页释放 observer、动画帧与监听器。聚焦／悬停交付收据可强调对应映射，不能改变 Git 边语义。

窄屏保留双轨，摘要、详情和收据换行；完整 SHA 不塞入轨道标签，不让模块或页面横向溢出。深浅主题都保留锚点及正文对比度，不用模糊滤镜实现“虚化”。

## 实现与验证

`render-versions.js` 保留模块入口及 main 图，`render-version-lineage.js` 负责来源图生命周期，`version-lineage-layout.js` 区分节点／映射身份，`version-lineage-mappings.js` 测量交付线；专用样式在 `styles-versions.css`，不套普通长文本预览裁切。详情重绘／导航清理由既有详情入口负责。

- `bun run test test/web/dom-versions.test.js test/web/version-lineage-layout.test.js test/web/version-graph-layout.test.js`：图语义、重复／共享／多落点映射、真实父边与外部边界、未交付／无开发／缺证据、签名分页与三页缓存、按需安全详情、取消／迟到保护、同 Worker 重绘及资源释放。
- `bun run scripts/check-versions-layout.js [截图目录]`：隔离临时项目的真实 Web → RPC → Project → SQLite/Git → Firefox，验证两次交付加当前未交付 commit、分页／缓存／刷新、来源／origin 详情、同步第二父边、原生子链接和 main、无交付／无开发及回收历史；额外 fixture 覆盖同源多落点、跨源共享落点、origin 目标、重复 Event 和不可核验落点的线条定位、展开后的重新测量。保留截图与证据，清理自有服务及临时项目，不操作用户服务或调用模型。

浏览器专项覆盖深浅主题及 1440／900／500px 顶层页面；390px 使用真实 iframe 内的生产 DOM/CSS 克隆检查几何（不是独立交互链路）。专项不替代最终集成与全量，未验证浏览器不宣称覆盖。

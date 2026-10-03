# Agent 指导：配置远程 Lush Host

本文交给帮助用户配置远程入口的 AI coding agent；用户的方案与风险说明见[远程 Host](remote-host.md)。先按[本机 Agent 指导](agent-guide.md)在后台机器准备 Linux/macOS 环境，再按本文配置访问。只改用户批准的部署配置，不修改 Lush 源码或项目代码。

## 1. 先确认机器与访问方案

明确哪个终端在后台机器、哪个在客户端；确认后台用户、Lush 检出、项目绝对路径、当前服务、SSH 参数或域名 / HTTPS 代理。用户没有选择时，先询问 SSH 隧道还是认证 HTTPS，不自行暴露端口。

- 只部署可信用户工具，不承诺多租户沙箱。
- 不覆盖已有 `web.json`、代理配置或凭证；只读检查后说明差异，变更前保留安全的恢复办法。
- 不将密码写入命令历史、聊天或报告。由用户通过可信配置编辑器提供秘密，文件和含秘密的备份必须仅 owner 可读。
- 防火墙、代理、提权、监听范围或服务重启必须经用户确认；活动工作不能自动中断。
- 示例路径 / 域名 / 账号 / 端口均需替换。不得修改项目绑定环境变量来绕过作用域校验。

## 2. SSH 隧道路线

SSH-only Linux 的内置桌面预检 / 首次部署见[SSH Agent 指导](ssh-desktop-agent.md)；以下为仍支持的手工配置。

保持远端 Host 的回环模式。先检查对应作用域是否已有 `web.json`；存在时说明它会启用认证和全接口监听，不为了隧道自动删除原配置。

在远端 Lush 源码目录启动显式单项目后台（已有服务先查状态，不重复换版本）：

```bash
bun run start --project /srv/projects/demo
bun run host 4318 --project /srv/projects/demo
bun run doctor --project /srv/projects/demo
bun run host-status --project /srv/projects/demo
```

客户端隧道命令与端口隔离规则统一见[远程桌面说明](remote-desktop.md#https-与-ssh-隧道)。先验证 SSH 主机身份，未知指纹让用户核对；不得关闭 host key 检查。转发仅绑定客户端回环地址，不开放 `0.0.0.0`，不同远端不得复用同一本地端口。

默认无认证 Host 要求本地转发端口与远端监听端口相同。若需 `14318 → 4318`，经用户确认，在远端源码目录启动时显式声明：

```bash
LUSH_WEB_SSH_ORIGIN=http://127.0.0.1:14318 bun run host 4318 --project /srv/projects/demo
```

此变量只接受带明确端口的 `http://127.0.0.1:PORT`，服务仍仅监听远端回环并检查 Host / Origin。它不能与同作用域 `web.json` 并用；已有 Host 需先核对作用域、版本和入口，再经用户确认重启，不以重复 `host` 自动换配置。自动桌面部署会在独立 profile 中声明该 origin，不改现有公开入口。

先验证远端 HTTP，再验证客户端转发地址；保持隧道终端运行。在浏览器或 Electron 打开转发地址，读取项目状态。断开隧道只断入口，不停止项目 daemon。

## 3. 配置认证与项目范围

仅用于用户确认的 HTTPS 路线。**创建认证文件会使 Host 监听 `0.0.0.0`**；必须先安排后台 HTTP 端口只允许回环或指定代理来源访问，再启动 / 重启认证模式，不能留一个裸露的明文 `4318`。

| 模式 | 认证文件位置 |
|---|---|
| 显式单项目 | `<project>/.lush/web.json` |
| Linux 多项目启动器 | `${XDG_CONFIG_HOME:-~/.config}/lush/web.json` |
| macOS 多项目启动器 | `~/Library/Application Support/Lush/web.json` |

若已有 `LUSH_GLOBAL_CONFIG` 覆盖，使用它指定的启动器目录，不另外写默认目录。Windows 原生客户端不运行 Host，WSL 使用 Linux 路径。

文件必须由后台用户拥有，权限为 `600`，且不能是符号链接。单项目配置模板：

```json
{
  "version": 1,
  "username": "your-name",
  "password": "REPLACE-WITH-PRIVATE-PASSWORD",
  "origin": "https://lush.example.com"
}
```

必须替换示例密码，实际密码去掉首尾空白后为 12–1024 字符，不把模板密码投入使用。首次启动会把 `password` 原子替换成 scrypt `password_hash`；已有 hash 不得同时添加 `password`。

多项目启动器在上述字段基础上必须增加非空白名单，例如：

```json
"projects": ["/srv/projects/demo", "/srv/projects/another"]
```

这是需要合入对象的字段片段，不是完整 JSON 文件。路径必须是后台机器的现存绝对目录；canonical 后只允许白名单命中的项目。不能复制本机历史登记列表充当授权决定。

## 4. 配置 HTTPS 与启动

沿用用户选择的代理和证书管理方式，不默认另装代理或接管域名。HTTPS 对外只提供 Host 根入口，不挂任意子路径；证书必须在客户端可信，不能使用跳过 TLS 验证的访问方式。

代理转发到实际 Host HTTP 端口，并保留正确 Host；上节模板中的 `origin` 登记完整对外协议 / 域名 / 端口。使用已有 nginx 时，location 可参考（TLS server / 证书配置需按目标环境补齐）：

```nginx
location / {
    proxy_pass http://127.0.0.1:4318;
    proxy_set_header Host $http_host;
}
```

多个确实需要的入口可用 `origins` 数组登记；不得为了消除 403 放宽到无关站点。不要删除同源检查或把明文 HTTP 当作 HTTPS 部署完成。

从远端 Lush 源码目录启动单项目模式使用上节命令；多项目模式用 `bun run host 4318`，确保没有显式项目或继承 `LUSH_PROJECT` 使它进入单项目模式。环境冲突时报告用户，不自行重绑。

已有 Host 需经用户同意用匹配作用域的 `host-restart` 重新读取认证配置；`host` 本身幂等，不更新运行中的旧配置。重启会清空登录会话；daemon 如需更新另用 `daemon-restart`，不顺带重启所有项目。

## 5. 验证与排错

在后台和实际客户端分别验证，报告机器身份与观察结果：

- `doctor --project ...` / `host-status` 确认代码身份、端口与日志位置。
- SSH 路线：Host 是预期回环模式，隧道仅绑定本地回环，项目页面可读。
- HTTPS 路线：证书可信；未登录不能读取项目 API，用户能登录并读取授权项目；确认未授权项目无法通过列表或已知 URL 越权访问。
- 全局白名单、实际监听地址和网络隔离一起检查；仅从回环能连通不证明公网端口已被隔离。
- API 404 优先核对 Host 代码版本；登录 403 检查代理 Host / `origin` 与日志，不靠关闭保护修复。
- 会话默认 12 小时；连续输错 5 次锁 60 秒，不在生产服务上反复猜密码测试锁定。

默认不提交输入、不调用模型。真实 Agent 烟测另获用户同意，在隔离项目验证成本与改动范围；断线不自动重试结果未知的写操作。

## 6. 交付与恢复

交付 Host 根地址、访问方式、项目范围、配置文件路径、监听 / 网络隔离结果、实际验收与缺项、日志、启动 / 重启 / 停止命令；报告不含密码、Cookie、密钥或 hash。

HTTPS 回退需用户批准并恢复对应配置 / 代理 / 网络规则；移走认证文件后必须重启 Host 才会变回回环模式，不自动删除认证或项目状态。仅停止入口用匹配作用域的 `host-stop`，停止 daemon 则需单独按项目确认。不要删除 `.lush/`、客户端 Cookie 或用户 SSH 密钥作为清理。

---

[← 用户说明](remote-host.md) · [返回部署索引](README.md)

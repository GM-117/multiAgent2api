# 部署到华为云 ECS（HTTP + 端口）

本分支（`deploy/server`）用于把 multiAgent2Api 打包部署到没有域名的服务器，通过
**明文 HTTP + 端口** 对外提供管理界面与 OpenAI 兼容接口。

## 实际部署参数

| 项 | 值 |
| --- | --- |
| 主机 | `root@115.120.210.69`（Ubuntu 24.04.5 LTS，x86_64，2C / 1.7G / 40G） |
| 对外端口 | `7888`（需在华为云安全组放行入方向 TCP 7888） |
| 管理界面 | `http://115.120.210.69:7888/admin` |
| OpenAI 兼容 | `http://115.120.210.69:7888/v1`（Bearer 用网关 Key） |
| 健康检查 | `http://115.120.210.69:7888/healthz` |
| 应用目录 | `/opt/multiagent2api`（`data/` 为状态目录） |
| 环境变量 | `/etc/multiagent2api.env`（`0600`） |
| systemd | `multiagent2api.service`（开机自启、失败重启） |
| 运行用户 | `multiagent2api`（system / nologin） |
| 插件网关 | 只绑 `127.0.0.1:8326`，由本服务 `/v1` 反代对外 |

## 为什么不用 Docker / 不在服务器上 pnpm install

- 服务器 `github.com`（git 协议）不可达，而 `dsh-providers-hub` 是 git 依赖 —— 服务器上装依赖会卡住；
  `codeload.github.com` 与 npm 镜像可达，但不值得赌。
- 运行期有两个**平台相关**原生模块：`sharp`（附件处理）与 `wreq-js`（opencode 传输）。
  因此不能在 macOS 上直接复用 `node_modules`，必须在打包时为 linux-x64 解析。
- 所以：**本机构建 + 本机为 linux-x64 解析生产依赖 + 整包上传**，服务器只需要一个 Node。

## 目录结构（服务器）

```
/opt/multiagent2api/
├── dist/            # 前端（/admin 静态资源）
├── dist-server/     # 后端编译产物（node dist-server/index.js）
├── node_modules/    # linux-x64 运行期依赖（含 sharp/wreq 原生绑定）
├── package.json     # 运行期只需要 "type": "module"
└── data/            # MULTIAGENT2API_HOME：账号、凭据、密钥
    ├── .credentials.yaml
    ├── admin-key
    ├── openai-gateway/api-key
    └── jet-hub/state.json
```

## 首次部署 / 升级

```bash
bash deploy/deploy.sh                      # 默认 root@115.120.210.69，端口 7888
bash deploy/deploy.sh --port 7888 --skip-build
```

脚本会：构建 → 在临时目录为 linux/x64/glibc 解析生产依赖（校验 linux 原生绑定、拒绝 darwin 残留）
→ 打 tar.gz → 上传 `/tmp` → 远端执行 `deploy/install.sh`（停服、替换代码、保留 `data/`、装 unit、放行 ufw、健康检查）。

## 迁移本机账号到服务器

```bash
# 1) 先停掉本机实例（脚本会检查 8080 端口，未停会拒绝）
# 2) 打状态包
bash deploy/pack-local-state.sh /tmp/m2a-state.tar.gz
# 3) 随部署一起导入（服务器 data/ 已有状态时需加 --force-state 覆盖）
bash deploy/deploy.sh --state /tmp/m2a-state.tar.gz --force-state
```

迁移后本机 `~/.multiAgent2Api` 保持原样，作为回滚备份；**不要把同一批凭据在两边同时使用**，
否则同一条 refresh_token 会被先续期的一方兑换掉。

> ⚠️ **CodeArts（华为云）对这一点尤其敏感**：华为 STS 的 `refresh_token` 是**一次性轮换**的。
> 两边共用同一份凭据时，谁先续期谁就消费掉它，另一方之后每次续期只会得到
> `STS5.1806 / the refresh token has been used`，且**不会自愈**（面板仍显示「自动续期」，
> 但积分查询会报 `APIG.0602 the security token has expired`）。
>
> 需要本地和服务器都用同一个 CodeArts 账号时，**在两边各自重新登录一次**：每次登录
> 都会签发一条独立的 token 家族，之后两个实例可以同时运行、互不影响。
> **不要**再用备份/整目录拷贝把 CodeArts 凭据同步到另一台机器（「整体还原」会覆盖
> 对方那条家族，重新变成互相失效）；迁移账号时用「单独导入」或直接在目标机登录。

## 运维命令

```bash
systemctl status multiagent2api
journalctl -u multiagent2api -f
systemctl restart multiagent2api

cat /opt/multiagent2api/data/admin-key                     # 管理密钥
cat /opt/multiagent2api/data/openai-gateway/api-key        # 网关 Key
curl -s http://127.0.0.1:7888/healthz
```

## 安全边界（HTTP 部署）

- 管理端**有**登录（HttpOnly 会话 Cookie，失败按 IP 限速 10 次/10 分钟），但链路上是明文 ——
  管理密钥等同密码，勿外泄。
- 网关 Key 与调用方 Key 的鉴权在应用内完成；明文 HTTP 下 Key 可被链路中间人看到，
  已知取舍。
- 非 HTTPS（非安全上下文）的浏览器限制：`http://IP` 下「回调修复」的
  「读取剪贴板」按钮不可用（可手动粘贴），上游加密备份导出（依赖 `crypto.subtle`）会失败。
- 需要 TLS 时，在前面加一层 nginx/caddy 即可，应用无需改动。

## 撤销

```bash
systemctl disable --now multiagent2api
rm -rf /opt/multiagent2api /etc/multiagent2api.env /etc/systemd/system/multiagent2api.service
systemctl daemon-reload
ufw delete allow 7888/tcp
```

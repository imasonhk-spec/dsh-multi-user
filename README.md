# dsh-multi-user — DSH 多用户管理网关

给任意一台 DSH（DeepSeek Harness）主机加一层**多用户门面**：一个登录页、一个管理员控制台，
以及**每用户完全独立的空间**。

- 🚪 **登录门禁**：服务端会话（scrypt 口令哈希 + HttpOnly Cookie），未登录一律拦在门外，
  还有一个"改密码 / 禁用账号 → 立刻踢下线"的强制失效语义。
- 👥 **管理员控制台** `/mu/admin`：用户**增、删、查、改**（角色 / 状态 / 备注 / 重置密码），
  以及**批量导入**——可下载 **Excel 模板**填写后上传（`.xlsx` / `.csv`），也可直接粘贴多行文本，
  两者都逐行汇报结果。管理员也可以在 DSH 会话里用自然语言让模型
  调 `mu_*` 工具完成同样的事。
- 🧱 **真正的独立空间**：每个账号由**自己的 `dsh web` 进程**服务，拥有自己的 `$DSH_HOME`。
  会话、凭据、设置、profiles、storages、工作区都是物理隔离的目录 —— 不是"过滤掉别人数据"的
  伪隔离，而是**别人的数据根本不在你的实例里**。
- 📦 **零依赖、零构建**：纯 `node:*` 标准库，没有 npm 依赖、没有前端构建步骤、不写死任何绝对路径，
  `dsh plugin --profile web add <tgz>` 装完重启即用。

## 快速开始

```bash
# 1) 装进 web profile（在 DSH 安装目录执行）
dsh plugin --profile web add /path/to/dsh-multi-user-1.0.1.tgz

# 2) 给宿主 DSH 进程设置一个启动 token（adminHomeMode: host 需要）
#    例如 systemd 单元里加一行 Environment=DSH_WEB_TOKEN=<长随机串>
#    然后重启 DSH

# 3) 首次启动会打印初始管理员用户名和密码，也写在
#    $DSH_HOME/multi-user/INITIAL_ADMIN.txt（0600）
```

浏览器打开 `http://<主机>:3090/mu/login`（默认端口 3090，见下）即可。

## 它是怎么工作的

```
浏览器 ──► 网关 :3090 ──┬─ /mu/*        登录页 / 管理控制台 / REST API
                        ├─ 其他路径 ──► 你的独立实例 A  (127.0.0.1:310xx, DSH_HOME=A)
                        └─ 其他路径 ──► 你的独立实例 B  (127.0.0.1:310xx, DSH_HOME=B)
```

网关把 `Host` 改写成 `127.0.0.1:<上游端口>`，并代持上游的 `dsh-auth-*` Cookie，
所以上游实例始终只绑定回环地址，浏览器永远看不到它的凭据。

### 账号 → 空间

| | 管理员（默认） | 普通用户 |
| --- | --- | --- |
| 空间来源 | `adminHomeMode: host` → 直接用**运行插件的那个 DSH 实例**，你原有的会话/工作区全部保留 | 首次访问时由网关自动拉起一个独立 `dsh web` 进程 |
| `$DSH_HOME` | 保持原样（`~/.dsh` 等） | `<dataDir>/users/<用户名>/home` |
| 工作区 | 保持原样 | `<dataDir>/users/<用户名>/workspace` |
| 端口 | 宿主端口（如 3080） | 从 `portBase`（默认 31000）顺序分配，记录在账号里 |
| 生命周期 | 即宿主进程 | 常驻，空闲超过 `idleTimeoutMinutes`（默认 30 分钟）后自动回收，下次访问自动重启 |
| 新账号是否可直接用 | — | 是。创建时会把宿主的 `.credentials.yaml` 等配置复制过去（`seedOnCreate`） |

把 `adminHomeMode` 改成 `managed`，管理员也会得到一个独立实例，行为完全对齐。

## 配置

插件的 bundle patch（`node_modules/dsh-multi-user/cordis.patch.yml`）里给了默认值。
在**你自己 profile** 的 `cordis.patch.yml` 里用 `id` 覆盖（整块 `config` 会被替换，需要重写全部键）：

```yaml
- id: dsh-multi-user
  config:
    listenHost: '127.0.0.1'   # 只监听本机，前面挂 nginx
    listenPort: 3090
    basePath: /mu
    adminHomeMode: host
    trustProxy: true          # 前面有 nginx 时开启，用 X-Forwarded-For 做登录限速
    seedOnCreate: true
    idleTimeoutMinutes: 30
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后插件完全空转 |
| `listenHost` / `listenPort` | `0.0.0.0` / `3090` | 网关监听地址；`0` 表示由系统分配 |
| `basePath` | `/mu` | 网关自有路径前缀 |
| `dataDir` | `$DSH_HOME/multi-user` | 用户库、会话、日志、各用户空间 |
| `dshRoot` | 宿主进程 cwd | 拉起独立实例时的 `cwd`（DSH 安装目录） |
| `dshBin` | `pnpm` | 拉起实例用的可执行文件；`dshArgs` 可补参数 |
| `adminHomeMode` | `host` | `host` / `managed` |
| `hostTokenEnv` | `DSH_WEB_TOKEN` | 宿主实例启动 token 所在的环境变量 |
| `portBase` / `portScanRange` | `31000` / `200` | 独立实例端口分配 |
| `sessionTtlHours` | `24` | 登录会话有效期 |
| `idleTimeoutMinutes` | `30` | 独立实例空闲回收；`0` 关闭回收 |
| `startTimeoutSeconds` | `120` | 拉起独立实例的等待上限 |
| `seedOnCreate` / `seedFiles` | `true` / 见下 | 新账号从宿主复制哪些配置文件（默认 `.credentials.yaml`、`.env`、`settings.yaml`、`.agent-presets`） |
| `bootstrapAdmin` / `bootstrapAdminUsername` / `bootstrapAdminPassword` | `true` / `admin` / 自动生成 | 首次启动的初始管理员 |
| `loginMaxFailures` / `loginLockMinutes` | `5` / `10` | 按 IP 的登录失败锁定 |
| `trustProxy` | `false` | 是否信任 `X-Forwarded-For`（仅在你自己的反代后面开） |
| `injectLogoutWidget` | `true` | 在被代理的页面里注入右下角"已登录 / 退出"浮标 |
| `inheritProfile` / `profile` | `true` / `web` | 把宿主 `profiles/<profile>/` 的应用集镜像给每个账号（宿主装一次，人人可用） |
| `syncProfileOnStart` / `appSyncIntervalMs` | `true` / `2000` | 每次使用账号时核对应用集；有变化就重启该账号实例。`appSyncIntervalMs` 是两次核对之间的最短间隔 |
| `minPasswordLength` | `8` | 自助改密窗口允许的最短密码 |
| `userProfilePatch` | `''` | 追加进每个账号 `cordis.patch.yml` 的 YAML（per-account 覆盖）。占位符见下 |
| `userSeedLinks` | `{}` | 在每个账号 home 里建的符号链接 `{ '账号内相对路径': '宿主绝对路径' }`，用于共享只读大块（模型、venv），不复制 |
| `sidecarPortBase` | `32000` | `{sidecarPort}` 的基数；实际端口 = `sidecarPortBase + slot`（账号序号） |

所有键也可用环境变量覆盖：`DSH_MU_LISTEN_PORT`、`DSH_MU_ADMIN_HOME_MODE`…

### 继承来的应用：怎么让数据也私有

`inheritProfile` 解决的是"**看不到**"——应用装上就能看见。但有些插件（典型是知识库
这类带后台进程的）会**在固定端口上 adopt 已经跑着的进程**，于是每个账号虽然各自有
`dsh web`，却都连到了宿主那一个后台，数据其实是共享的。这时的补法是 `userProfilePatch`：
用 per-account 覆盖把后台挪到每个账号自己的端口和数据目录上，`userSeedLinks` 再把只读的
大块（模型文件、Python venv）链接过去，避免每个账号复制几 GB。

以 `dsh-raganything-kb` 为例（放在宿主 `profiles/web/cordis.patch.yml` 里）：

```yaml
- id: dsh-multi-user
  config:
    # 注意：cordis patch 是整体替换 config，这里要把该行的其它键一并重述
    enabled: true
    listenHost: '0.0.0.0'
    listenPort: 3090
    basePath: /mu
    adminHomeMode: host
    sidecarPortBase: 32000
    userProfilePatch: |-
      - id: raganything-kb
        config:
          ragHome: '{home}/raganything'
          sidecarPort: {sidecarPort}
          sidecarConfig: '{home}/raganything/config.json'
          pythonBin: /home/<user>/.dsh/raganything/venv/bin/python
    userSeedLinks:
      raganything/models: /home/<user>/.dsh/raganything/models
      raganything/venv: /home/<user>/.dsh/raganything/venv
```

效果：每个账号第一次用知识库时，在自己的 `{home}/raganything/` 下用模板生成
`config.json`（`working_dir` / `output_dir` / `models_dir` 都指向自己），在
`sidecarPortBase + slot` 上起**自己的** sidecar；模型和 venv 走符号链接共享，不重复占盘。
代价是每个真正在用知识库的账号会多一个 Python sidecar 进程（实测约 2.5 GB RSS），
所以它只在账号**首次调用知识库时**才启动。把 `userProfilePatch` 清空即可回退——
下次同步会把这一段从各账号的 patch 文件里摘掉，账号自己写的条目不受影响。

## HTTP 接口

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| `GET` | `/mu/login` | 匿名 |
| `POST` | `/mu/api/login` | 匿名（JSON 或表单） |
| `GET` | `/mu/logout` | 登录后 |
| `GET` | `/mu/api/me` | 登录后 |
| `POST` | `/mu/api/password` | 登录后（改**自己**的密码，需提供当前密码） |
| `GET` | `/mu/account` | 登录后（账号信息页：改密、查看可用应用） |
| `GET` | `/mu/admin` | admin |
| `GET` | `/mu/api/users` | admin |
| `POST` | `/mu/api/users` | admin |
| `PUT` | `/mu/api/users/:name` | admin |
| `DELETE` | `/mu/api/users/:name?purge=false` | admin |
| `POST` | `/mu/api/users/:name/password` | admin |
| `POST` | `/mu/api/users/import` | admin（粘贴文本批量导入） |
| `GET` | `/mu/api/users/import/template[?format=csv]` | admin（下载导入模板） |
| `POST` | `/mu/api/users/import/upload?defaultRole=&onExisting=&filename=` | admin（上传表格批量导入，请求体即文件） |
| `GET` | `/mu/api/status` | admin |

批量导入的 `text` 支持每行：`用户名`、`用户名,密码`、`用户名,密码,角色`、`用户名,密码,角色,备注`
（逗号或 Tab 分隔，`#` 为注释）。密码留空自动生成，`onExisting` 选 `skip` 或 `update`。

### Excel 模板批量导入

管理台「批量导入」页支持下载模板 → 填写 → 上传：

- 模板是**真正的 `.xlsx`**（ZIP + OOXML，由 `lib/spreadsheet.js` 用 `node:zlib` 直接写出，**不引入任何依赖**），
  含两张表：`用户`（数据表，导入时只读第 1 张表）与 `填写说明`。表头加粗，`用户名`/`密码` 两列设为
  **文本格式**以免前导零丢失，`角色`/`状态` 列带下拉选项。
- 上传同样零依赖：`.xlsx`/`.xlsm` 走自写 ZIP+XML 解析（支持 sharedStrings 与 inlineStr）；
  `.csv`/`.tsv` 支持引号转义、自动识别分隔符，并自动处理 UTF-8 / **GB18030/GBK** / UTF-16 编码
  （中文 Windows 版 Excel 导出的 CSV 默认是 GBK）。旧版 `.xls` 会被明确拒绝并提示另存为。
- 列**按列名识别**，顺序可调换，别名包括 `用户名/账号/username/user`、`密码/password`、
  `角色/role`、`状态/status`、`备注/说明/note/remark/部门` 等；识别不到表头时退回旧的位置约定
  `A=用户名 B=密码 C=角色 D=备注`。
- 表格比文本多一个 `状态` 列（`active` / `disabled`），其余语义完全一致——两种入口共用
  `store.importUsers()` 的同一套冲突处理与逐行汇报，`onExisting` 决定已存在账号是跳过还是更新。
- 单次上限 2000 行；空行与 `#` 开头的行会被忽略；有问题的行不会中断整批，逐行给出原因。

## 模型工具

`mu_users_list`、`mu_user_create`、`mu_user_update`、`mu_user_delete`、`mu_users_import`、`mu_gateway_status`。

## 可移植性边界

| 项目 | 是否随包分发 | 说明 |
| --- | --- | --- |
| 插件源码 | ✅ | 纯 JS，无构建 |
| 配置文件 | ❌ | 首次启动按本机路径生成；`dataDir` 指向本机 `$DSH_HOME` |
| 用户数据 / 各用户空间 | ❌ | 每台机自带独立数据，绝不互相复制 |
| `DSH_WEB_TOKEN` | ❌ | 目标机自己设置 |
| nginx / systemd 单元 | ⚠️ | 安装脚本可选帮你改，且会先备份 |

## 已知限制

- 独立实例目前**不做 CPU/内存配额**。一台机上同时活跃的账号越多，内存占用越高
  （每个 `dsh web` 进程约 0.3–1 GB）。用 `idleTimeoutMinutes` 控制常驻数量。
- 独立实例绑定 `127.0.0.1`。**同一台机器的其它本地用户**若能执行代码，理论上可以直连这些端口；
  但端口需要该实例的 token 才能通过鉴权，且 DSH 本身也要求 Host 属于可信范围。
- 插件把 `/` 之外的所有路径都当作需要登录，因此**直连宿主端口**（如 `:3080`）会绕过网关。
  生产部署请把对外的入口（nginx / 端口映射）指向网关端口。
- 网关不解析 `/api` 的 RPC 语义，只做按账号的**上游路由**；同源下的会话流（WebSocket）同样是
  按账号路由的整条隧道，不做内容改写。

## 卸载

```bash
dsh plugin --profile web remove dsh-multi-user
# 用户数据默认保留在 $DSH_HOME/multi-user，确认不需要后再手动删除
```

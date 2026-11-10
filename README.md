# dsh-multi-user 1.2.2

多用户网关插件

## 这是什么

自包含 DSH 插件包。**下载解包即可安装，无需额外下载依赖或后台服务。**

包含内容：

| 组件 | 是否内联 |
|---|---|
| 插件代码（已构建） | ✅ |
| Node 依赖 | ✅ 已 bundle 进插件本体 |
| Python venv | — 不需要 |
| 后台服务（systemd unit + 应用目录） | — 无 |
| 模型权重 | ❌ 不带（指向可配置端点） |
| DSH 底座 | ❌ 不含（`--with-base` 自动拉取） |

## 安装

```bash
tar -xzf dsh-multi-user-1.2.2.tar.gz
cd dsh-multi-user-1.2.2
sudo ./install.sh
```

### 选项

| 参数 | 作用 |
|---|---|
| `--with-base` | 本机没有 DSH 时，自动从 `imasonhk-spec/dsh` 拉取底座并安装 |
| `--dry-run` | 只打印将要做什么，不落盘 |
| `--skip-restart` | 装完不重启 dsh-web |
| `--force` | 覆盖已有的 venv / 配置 |

## 它会装到哪里

- **宿主 profile**：`~/.dsh/profiles/web/node_modules/`
- **所有已存在账号**：`~/.dsh/multi-user/users/<账号>/home/profiles/web/node_modules/`
- **后台服务**：`/etc/systemd/system/<unit>.service`

## 幂等性

| 情况 | 行为 |
|---|---|
| 服务已 `active` | **跳过**，不动它 |
| 服务 `inactive`/`failed` | 重写 unit 并重启 |
| venv 已存在 | 跳过（`--force` 才覆盖） |
| 插件目录已存在 | 覆盖为新版本 |

## 密钥

包内**不含任何真实密钥**。所有 token / 密码 / secret 在安装时用
`openssl rand -hex 24` 现场生成，写入 `~/.dsh/publish-env/` 并 `chmod 600`。

## 卸载

```bash
sudo ./uninstall.sh
```

## 端口



## 验证

```bash
# 服务状态
systemctl status dsh-web

# 插件是否被 loader 接受（需带 cookie）
curl -s -b /tmp/cookie 'https://<host>:3082/api/<plugin>/state'
```

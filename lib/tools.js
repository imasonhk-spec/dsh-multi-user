/**
 * dsh-multi-user — model-facing host tools.
 *
 * The administrator can run the whole roster from a chat session: list, create,
 * update, delete, bulk-import. The tools call the very same operations the HTTP
 * console uses, so the two surfaces can never drift.
 *
 * @module dsh-multi-user/tools
 */

function formatBeijing(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (北京时间)';
}

function line(user) {
  const last = user.lastLoginAt === null || user.lastLoginAt === undefined ? '从未登录' : formatBeijing(user.lastLoginAt)
  return `- ${user.username} | ${user.role} | ${user.status} | ${user.homeMode} | 最后登录 ${last} | 空间 ${user.homeDir ?? '(按需创建)'}`
}

function describeCreate(outcome) {
  const rows = [
    `已创建用户 ${outcome.user.username}`,
    `  角色: ${outcome.user.role}`,
    `  状态: ${outcome.user.status}`,
    `  独立空间: ${outcome.homeDir}`,
    `  工作区:   ${outcome.workspaceDir}`,
  ]
  if (outcome.generatedPassword !== undefined) {
    rows.push(`  初始密码: ${outcome.generatedPassword}  ← 请立即转告用户，仅显示这一次`)
  }
  if (Array.isArray(outcome.seeded) && outcome.seeded.length > 0) {
    rows.push(`  已复制宿主配置: ${outcome.seeded.join(', ')}（该用户可立即使用模型）`)
  }
  return rows.join('\n')
}

/**
 * Build the tool definitions.
 * @param deps - `{ admin, config, supervisor, gateway }`.
 * @returns an array of DSH tool definitions.
 */
export function createTools(deps) {
  const { admin, config, supervisor } = deps

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  return [
    {
      name: 'mu_users_list',
      description: '列出 DSH 多用户网关上注册的全部账号（用户名、角色、状态、空间模式、最后登录、独立空间目录）。做任何用户管理前的第一步。',
      parameters: { type: 'object', properties: {} },
      output: textOutput,
      async execute() {
        const users = admin.list()
        if (users.length === 0) return '当前没有任何用户。'
        return [`共 ${users.length} 个账号：`, ...users.map(line)].join('\n')
      },
    },
    {
      name: 'mu_user_create',
      description:
        '在 DSH 多用户网关上创建一个新用户，并为其分配完全独立的 DSH 空间（独立会话、独立凭据、独立工作区）。密码留空则自动生成强密码并在结果中返回一次。',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', required: true, description: '用户名：字母或数字开头，可含 . _ -，1-32 位' },
          password: { type: 'string', description: '登录密码；留空自动生成' },
          role: { type: 'string', enum: ['user', 'admin'], description: '角色，缺省 user' },
          status: { type: 'string', enum: ['active', 'disabled'], description: '状态，缺省 active' },
          note: { type: 'string', description: '备注（部门、用途等）' },
        },
      },
      output: textOutput,
      async execute(args) {
        const outcome = await admin.create(args, 'model-tool')
        if (outcome.error !== undefined) throw new Error(outcome.error)
        return describeCreate(outcome)
      },
    },
    {
      name: 'mu_user_update',
      description:
        '修改 DSH 多用户网关上的一个已有用户：角色、启用/禁用状态、备注或重置密码。修改密码或禁用账号会立刻使其所有登录会话失效。',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', required: true, description: '目标用户名' },
          role: { type: 'string', enum: ['user', 'admin'], description: '新角色' },
          status: { type: 'string', enum: ['active', 'disabled'], description: '新状态' },
          password: { type: 'string', description: '新密码；传空字符串表示自动生成一个强密码' },
          note: { type: 'string', description: '新备注' },
        },
      },
      output: textOutput,
      async execute(args) {
        const { username, ...patch } = args
        const rotate = Object.prototype.hasOwnProperty.call(patch, 'password') && String(patch.password ?? '').length === 0
        if (!rotate && !Object.prototype.hasOwnProperty.call(patch, 'password')) delete patch.password
        const outcome = await admin.update(username, patch, { actor: 'model-tool', rotatePassword: rotate })
        if (outcome.error !== undefined) throw new Error(outcome.error)
        const rows = [`已更新用户 ${username}`]
        if (outcome.generatedPassword !== undefined) rows.push(`  新密码: ${outcome.generatedPassword}  ← 仅显示这一次`)
        if (outcome.revokedSessions > 0) rows.push(`  已强制下线 ${outcome.revokedSessions} 个登录会话`)
        return rows.join('\n')
      },
    },
    {
      name: 'mu_user_delete',
      description:
        '从 DSH 多用户网关上删除一个用户。默认保留其空间目录（可恢复）；purge=true 会同时彻底删除该用户的全部数据，不可恢复。不能删除最后一个启用的管理员。',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', required: true, description: '目标用户名' },
          purge: { type: 'boolean', description: '是否连该用户的独立空间数据一并删除，缺省 false（保留）' },
        },
      },
      output: textOutput,
      async execute(args, exec) {
        const actor = String(exec?.agent?.id ?? '') === '' ? 'model-tool' : 'model-tool'
        const outcome = await admin.remove(args.username, { actor, purge: args.purge === true })
        if (outcome.error !== undefined) throw new Error(outcome.error)
        const rows = [`已删除用户 ${args.username}`]
        if (outcome.purged) rows.push('  其独立空间数据已一并删除')
        else if (outcome.spaceDirKept !== undefined) rows.push(`  空间目录已保留: ${outcome.spaceDirKept}`)
        if (outcome.revokedSessions > 0) rows.push(`  已强制下线 ${outcome.revokedSessions} 个登录会话`)
        return rows.join('\n')
      },
    },
    {
      name: 'mu_users_import',
      description:
        '批量导入用户。每行一个账号，支持「用户名」「用户名,密码」「用户名,密码,角色」「用户名,密码,角色,备注」（逗号或 Tab 分隔，# 开头为注释）。密码留空自动生成。会返回每个账号的明细。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true, description: '要导入的多行文本' },
          defaultRole: { type: 'string', enum: ['user', 'admin'], description: '未指定角色时的默认角色，缺省 user' },
          onExisting: { type: 'string', enum: ['skip', 'update'], description: '用户名已存在时：skip 跳过（缺省）或 update 更新' },
        },
      },
      output: textOutput,
      async execute(args) {
        const result = await admin.import(args)
        if (result.error !== undefined) throw new Error(result.error)
        const summary = result.summary ?? {}
        const rows = [
          `导入完成：新建 ${summary.created ?? 0}，更新 ${summary.updated ?? 0}，跳过 ${summary.skipped ?? 0}，失败 ${summary.failed ?? 0}。`,
        ]
        for (const row of result.results ?? []) {
          const extra = row.generatedPassword === undefined ? '' : `（密码 ${row.generatedPassword}）`
          rows.push(`  第 ${row.line} 行 [${row.status}] ${row.message}${extra}`)
        }
        return rows.join('\n')
      },
    },
    {
      name: 'mu_gateway_status',
      description: '查看 DSH 多用户网关的运行状态：监听地址、账号总数、在线登录会话数、当前由网关托管的每用户独立实例（端口、DSH_HOME、空闲时长）。用户反馈无法登录或空间打不开时用它诊断。',
      parameters: { type: 'object', properties: {} },
      output: textOutput,
      async execute() {
        const status = admin.status({})
        const rows = [
          `网关: ${deps.gatewayListen ?? '(未知)'}`,
          `数据目录: ${config.dataDir}`,
          `账号总数: ${status.gateway.users}   在线登录会话: ${status.gateway.sessions}`,
          `管理员空间模式: ${status.gateway.adminHomeMode}`,
          `DSH 安装目录: ${config.dshRoot}`,
          `启动命令: ${status.gateway.launcher.bin} ${[...status.gateway.launcher.args, 'web', '--no-open'].join(' ')}`,
        ]
        if (status.instances.length === 0) {
          rows.push('当前没有由网关托管的运行实例（普通用户首次访问时会自动启动）。')
        } else {
          rows.push(`运行中实例 ${status.instances.length} 个:`)
          for (const item of status.instances) {
            rows.push(`- ${item.username} | 127.0.0.1:${item.port} | ${item.alive ? '运行中' : '已停止'} | 空闲 ${Math.round(item.idleMs / 1000)}s | ${item.homeDir}`)
          }
        }
        if (status.gateway.adminHomeMode === 'host') {
          rows.push(`宿主的 DSH 版本/日志请见: ${config.logDir}`)
        }
        return rows.join('\n')
      },
    },
  ]
}

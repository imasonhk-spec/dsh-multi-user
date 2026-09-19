/**
 * dsh-multi-user — self-contained browser surfaces.
 *
 * The login page and the administrator console are emitted as single HTML
 * documents with inline CSS and JS. Keeping them build-free means the plugin
 * installs with nothing but a copy of its own folder — no vite, no React, no
 * node_modules — which is what makes it portable across DSH hosts.
 *
 * @module dsh-multi-user/admin-ui
 */

/** Escaping for values interpolated into HTML text or attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Server-side render helper: format an ISO timestamp as Beijing time. */
export function formatBeijingTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (北京时间)';
}

/** Shared design tokens and base component styles. */
const BASE_CSS = `
:root{
  color-scheme: light dark;
  --bg:#f5f6f8; --panel:#ffffff; --panel-2:#fafbfc; --border:#e3e6ea;
  --text:#1c1f23; --muted:#6b7280; --accent:#2f6fed; --accent-soft:#e8f0fe;
  --danger:#c0392b; --danger-soft:#fdecea; --ok:#1e7f4f; --ok-soft:#e7f5ee;
  --warn:#8a6100; --warn-soft:#fdf3d8; --radius:10px;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#15171a; --panel:#1d2024; --panel-2:#23262b; --border:#31353b;
    --text:#e7e9ec; --muted:#9aa1ab; --accent:#5b8dfa; --accent-soft:#1f2b45;
    --danger:#ef6d5b; --danger-soft:#3a1f1c; --ok:#4ec08a; --ok-soft:#16301f;
    --warn:#dcae4a; --warn-soft:#33280f;
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg);color:var(--text);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1120px;margin:0 auto;padding:24px 20px 64px}
h1{font-size:20px;margin:0 0 4px;font-weight:650}
h2{font-size:15px;margin:0 0 12px;font-weight:650}
.sub{color:var(--muted);font-size:13px;margin:0 0 20px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:16px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.grow{flex:1 1 160px;min-width:0}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}
input,select,textarea,button{font:inherit;color:inherit}
input,select,textarea{
  width:100%;background:var(--panel-2);border:1px solid var(--border);
  border-radius:8px;padding:8px 10px;outline:none;
}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
textarea{min-height:150px;font-family:var(--mono);font-size:12.5px;resize:vertical}
button{
  background:var(--accent);color:#fff;border:1px solid transparent;border-radius:8px;
  padding:8px 14px;cursor:pointer;font-weight:600;
}
button:hover{filter:brightness(1.07)}
button:disabled{opacity:.5;cursor:default}
button.ghost{background:transparent;color:var(--text);border-color:var(--border)}
button.danger{background:var(--danger)}
button.small{padding:4px 9px;font-size:12px;font-weight:500}
/* Links that must *navigate* rather than submit. Wrapping a <button> in an <a>
   is invalid HTML — interactive content may not nest — and its behaviour is
   browser-dependent. Style the anchor directly instead. */
a.btn{
  display:inline-block;background:var(--accent);color:#fff;border:1px solid transparent;
  border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600;text-decoration:none;
}
a.btn:hover{filter:brightness(1.07);text-decoration:none}
a.btn.ghost{background:transparent;color:var(--text);border-color:var(--border)}
a.btn.small{padding:4px 9px;font-size:12px;font-weight:500}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--panel-2)}
.mono{font-family:var(--mono);font-size:12px}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11.5px;font-weight:600;border:1px solid transparent}
.tag.admin{background:var(--accent-soft);color:var(--accent)}
.tag.user{background:var(--panel-2);color:var(--muted);border-color:var(--border)}
.tag.active{background:var(--ok-soft);color:var(--ok)}
.tag.disabled{background:var(--danger-soft);color:var(--danger)}
.tag.host{background:var(--warn-soft);color:var(--warn)}
.notice{border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px;border:1px solid transparent}
.notice.err{background:var(--danger-soft);color:var(--danger)}
.notice.ok{background:var(--ok-soft);color:var(--ok)}
.notice.info{background:var(--accent-soft);color:var(--accent)}
.empty{color:var(--muted);font-size:13px;padding:14px 2px}
.scroll{overflow:auto;-webkit-overflow-scrolling:touch}
.right{text-align:right;white-space:nowrap}
.muted{color:var(--muted)}
.hide{display:none !important}
.center{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.box{width:100%;max-width:370px;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:26px}
.brand{font-size:17px;font-weight:700;margin:0 0 2px}
.brand small{font-weight:400;color:var(--muted);font-size:12.5px;display:block;margin-top:3px}
.tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.tab{padding:8px 13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--muted);font-weight:600;font-size:13px}
.tab.on{color:var(--accent);border-bottom-color:var(--accent)}
.pw{font-family:var(--mono);background:var(--warn-soft);color:var(--warn);padding:1px 6px;border-radius:5px;font-size:12px}
`

/** Renders the sign-in page. */
export function loginPage({ basePath, next = '/', error = '', notice = '', allowSelfRegister = false }) {
  const action = `${basePath}/api/login`
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · DSH多用户网关--明松Mason 157141466</title><style>${BASE_CSS}</style></head>
<body><div class="center"><form class="box" method="post" action="${escapeHtml(action)}">
  <p class="brand">DSH多用户网关--明松Mason 157141466<small>DeepSeek Harness · Multi-User Gateway</small></p>
  <div style="height:14px"></div>
  ${error ? `<div class="notice err">${escapeHtml(error)}</div>` : ''}
  ${notice ? `<div class="notice info">${escapeHtml(notice)}</div>` : ''}
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <div style="margin-bottom:12px"><label for="u">用户名</label>
    <input id="u" name="username" autocomplete="username" autofocus required></div>
  <div style="margin-bottom:18px"><label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required></div>
  <button type="submit" style="width:100%">登录</button>
  ${allowSelfRegister ? `<p class="sub" style="margin:14px 0 0;text-align:center">没有账号？<a href="${escapeHtml(basePath)}/register">申请账号</a></p>` : ''}
</form></div></body></html>`
}

/** Script + widget injected into a proxied DSH page so a user can sign out. */
export function logoutWidget(basePath, username) {
  const payload = JSON.stringify({ basePath, username })
  return `<script data-dsh-multi-user="widget">(()=>{const C=${payload};
const M=document.createElement('div');M.style.cssText='position:fixed;z-index:2147483000;right:14px;bottom:14px;font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Noto Sans SC,sans-serif';
const S=M.attachShadow({mode:'open'});
S.innerHTML='<style>*{box-sizing:border-box}div.w{display:flex;align-items:center;gap:8px;background:rgba(28,31,35,.86);color:#eceff3;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:5px 6px 5px 13px;backdrop-filter:blur(8px);box-shadow:0 6px 22px rgba(0,0,0,.28)}span{white-space:nowrap}b{font-weight:650}button{font:inherit;cursor:pointer;background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:3px 10px}button:hover{background:rgba(255,255,255,.24)}a{color:#9dc0ff;text-decoration:none}a:hover{text-decoration:underline}</style><div class="w"><span>已登录 <b></b></span><a href="'+C.basePath+'/admin" target="_self">管理</a><button type="button">退出</button></div>';
S.querySelector('b').textContent=C.username;
S.querySelector('button').addEventListener('click',()=>{location.href=C.basePath+'/logout'});
document.body.appendChild(M);})();</script>`
}

/** Renders the administrator console. */
export function adminPage({ basePath, username }) {
  const boot = JSON.stringify({ basePath, username })
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>用户管理 · DSH 多用户网关</title><style>${BASE_CSS}
@media(min-width:900px){.fgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}}
.importgrid{display:grid;gap:12px;margin-bottom:4px}
@media(min-width:900px){.importgrid{grid-template-columns:1fr 1fr;gap:14px}}
.pane{background:var(--panel-2);border:1px solid var(--border);border-radius:10px;padding:14px}
.pane h3{font-size:13px;margin:0 0 7px;font-weight:650}
.pane textarea{min-height:164px}
.drop{border:1.5px dashed var(--border);border-radius:9px;padding:15px 12px;text-align:center;background:var(--panel);margin-top:11px}
.drop.hot{border-color:var(--accent);background:var(--accent-soft)}
.drop p{margin:0 0 6px}
.drop p:last-child{margin-bottom:0;font-size:12.5px}
</style></head>
<body><div class="wrap">
  <div class="row" style="justify-content:space-between;align-items:flex-start;margin-bottom:6px">
    <div>
      <h1>用户管理</h1>
      <p class="sub" style="margin:0">当前登录：<b>${escapeHtml(username)}</b> · 每个账号拥有独立的 DSH 空间（独立会话 / 凭据 / 工作区）</p>
    </div>
    <div class="row">
      <button class="ghost small" id="refresh">刷新</button>
      <a class="btn ghost small" href="${escapeHtml(basePath)}/account">我的账号</a>
      <a class="btn ghost small" href="${escapeHtml(basePath)}/workspace">返回工作台</a>
      <a class="btn small" href="${escapeHtml(basePath)}/logout">退出登录</a>
    </div>
  </div>

  <div id="flash"></div>

  <div class="tabs">
    <div class="tab on" data-tab="users">用户列表</div>
    <div class="tab" data-tab="create">新建用户</div>
    <div class="tab" data-tab="import">批量导入</div>
    <div class="tab" data-tab="status">运行状态</div>
  </div>

  <section id="tab-users">
    <div class="card" style="padding:0;overflow:hidden">
      <div class="scroll"><table>
        <thead><tr>
          <th>用户名</th><th>角色</th><th>状态</th><th>空间模式</th>
          <th>最后登录</th><th>独立空间目录</th><th class="right">操作</th>
        </tr></thead>
        <tbody id="userRows"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
      </table></div>
    </div>
  </section>

  <section id="tab-create" class="hide">
    <div class="card">
      <h2>新建用户</h2>
      <div class="fgrid">
        <div><label for="c-user">用户名 *</label><input id="c-user" placeholder="alice"></div>
        <div><label for="c-pass">密码（留空自动生成强密码）</label><input id="c-pass" type="text" placeholder="留空即自动生成"></div>
        <div><label for="c-role">角色</label><select id="c-role"><option value="user">user（普通用户）</option><option value="admin">admin（管理员）</option></select></div>
        <div><label for="c-status">状态</label><select id="c-status"><option value="active">active（启用）</option><option value="disabled">disabled（禁用）</option></select></div>
      </div>
      <div style="margin-top:6px"><label for="c-note">备注</label><input id="c-note" placeholder="可选"></div>
      <div class="row" style="margin-top:14px">
        <button id="c-submit">创建用户</button>
        <span class="muted" id="c-hint"></span>
      </div>
    </div>
  </section>

  <section id="tab-import" class="hide">
    <div class="card">
      <h2>批量导入用户</h2>
      <p class="sub" style="margin:-6px 0 14px">两种方式任选：下载 Excel 模板填写后上传，或直接粘贴账号清单。密码留空会自动生成强密码。</p>

      <div class="importgrid">
        <div class="pane">
          <h3>① 用 Excel 模板导入</h3>
          <p class="muted" style="margin:0 0 10px;font-size:12.5px">下载模板 → 在 <b>「用户」</b> 工作表里一行一个账号 → 上传。列按<b>列名</b>识别，顺序可以调换。</p>
          <div class="row" style="gap:6px">
            <a class="btn ghost small" href="${escapeHtml(basePath)}/api/users/import/template">下载 Excel 模板 (.xlsx)</a>
            <a class="btn ghost small" href="${escapeHtml(basePath)}/api/users/import/template?format=csv">下载 CSV 模板</a>
          </div>
          <div class="drop" id="i-drop">
            <input type="file" id="i-file" class="hide" accept=".xlsx,.xlsm,.csv,.tsv,.txt">
            <p>把填好的文件拖到这里，或 <button class="ghost small" type="button" id="i-pick">选择文件</button></p>
            <p class="muted" id="i-file-name">支持 .xlsx / .xlsm / .csv / .tsv（旧版 .xls 请先另存为 .xlsx 或 CSV）</p>
          </div>
        </div>

        <div class="pane">
          <h3>② 粘贴账号清单导入</h3>
          <p class="muted" style="margin:0 0 10px;font-size:12.5px">每行一个账号：<span class="mono">用户名</span>、<span class="mono">用户名,密码</span>、<span class="mono">用户名,密码,角色</span>、<span class="mono">用户名,密码,角色,备注</span>（逗号或 Tab 分隔，<span class="mono">#</span> 开头为注释）</p>
          <textarea id="i-text" placeholder="# 示例&#10;alice,Passw0rd123&#10;bob&#10;carol,Carol@2026,admin&#10;dave,,user,研发部"></textarea>
        </div>
      </div>

      <div class="fgrid" style="margin-top:14px">
        <div><label for="i-role">未指定角色时默认</label><select id="i-role"><option value="user">user</option><option value="admin">admin</option></select></div>
        <div><label for="i-existing">用户名已存在时</label><select id="i-existing"><option value="skip">跳过（保留原账号）</option><option value="update">更新（改角色/状态/备注，密码非空则重置）</option></select></div>
      </div>

      <div class="row" style="margin-top:14px">
        <button id="i-submit">导入粘贴内容</button>
        <button id="i-upload" disabled>上传文件并导入</button>
        <span class="muted">导入结果会列出每个账号</span>
      </div>
    </div>
    <div class="card hide" id="i-result"></div>
  </section>

  <section id="tab-status" class="hide">
    <div class="card">
      <h2>网关与实例</h2>
      <div id="statusBox" class="empty">加载中…</div>
    </div>
  </section>
</div>

<script>
const BOOT = ${boot};
const $ = (id) => document.getElementById(id);
const api = (path, options) => fetch(BOOT.basePath + path, {
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  ...options,
});
function flash(kind, html) {
  $('flash').innerHTML = html ? '<div class="notice ' + kind + '">' + html + '</div>' : '';
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(value) {
  if (!value) return '<span class="muted">从未</span>';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return esc(value);
  const s = date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return s + ' <span class="muted" style="font-size:11px">北京时间</span>';
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => other.classList.toggle('on', other === tab));
    ['users', 'create', 'import', 'status'].forEach((name) => {
      $('tab-' + name).classList.toggle('hide', name !== tab.dataset.tab);
    });
    if (tab.dataset.tab === 'status') loadStatus();
  });
});

let users = [];
async function loadUsers() {
  try {
    const body = await (await api('/api/users')).json();
    if (body.error) { flash('err', esc(body.error)); return; }
    users = body.users ?? [];
    if (users.length === 0) {
      $('userRows').innerHTML = '<tr><td colspan="7" class="empty">还没有用户。</td></tr>';
      return;
    }
    $('userRows').innerHTML = users.map((user) => {
      const dir = user.homeDir ? '<span class="mono">' + esc(user.homeDir) + '</span>' : '<span class="muted">按需创建</span>';
      const mode = user.homeMode === 'host'
        ? '<span class="tag host">host 实例</span>'
        : '<span class="tag user">独立实例</span>';
      return '<tr>'
        + '<td><b>' + esc(user.username) + '</b>' + (user.note ? '<div class="muted" style="font-size:12px">' + esc(user.note) + '</div>' : '') + '</td>'
        + '<td><span class="tag ' + esc(user.role) + '">' + esc(user.role) + '</span></td>'
        + '<td><span class="tag ' + esc(user.status) + '">' + esc(user.status) + '</span></td>'
        + '<td>' + mode + '</td>'
        + '<td>' + fmtTime(user.lastLoginAt) + '</td>'
        + '<td>' + dir + '</td>'
        + '<td class="right">'
        +   '<button class="ghost small" data-act="pw" data-user="' + esc(user.username) + '">重置密码</button> '
        +   '<button class="ghost small" data-act="role" data-user="' + esc(user.username) + '">改角色</button> '
        +   '<button class="ghost small" data-act="status" data-user="' + esc(user.username) + '">' + (user.status === 'active' ? '禁用' : '启用') + '</button> '
        +   '<button class="danger small" data-act="del" data-user="' + esc(user.username) + '">删除</button>'
        + '</td></tr>';
    }).join('');
  } catch (error) {
    flash('err', '读取用户列表失败：' + esc(error.message));
  }
}

$('userRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const name = button.dataset.user;
  const user = users.find((entry) => entry.username === name);
  if (!user) return;
  button.disabled = true;
  try {
    if (button.dataset.act === 'pw') {
      const value = prompt('为 ' + name + ' 设置新密码（留空自动生成强密码）：', '');
      if (value === null) return;
      const body = await (await api('/api/users/' + encodeURIComponent(name) + '/password', { method: 'POST', body: JSON.stringify({ password: value }) })).json();
      if (body.error) { flash('err', esc(body.error)); return; }
      flash('ok', '已重置 ' + esc(name) + ' 的密码'
        + (body.generatedPassword ? '：<span class="pw">' + esc(body.generatedPassword) + '</span>（请立即保存，仅显示一次）' : '')
        + '，该用户所有登录会话已失效。');
    } else if (button.dataset.act === 'role') {
      const role = prompt('输入新角色（admin / user）：', user.role);
      if (role === null) return;
      const body = await (await api('/api/users/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ role: role.trim() }) })).json();
      if (body.error) { flash('err', esc(body.error)); return; }
      flash('ok', esc(name) + ' 的角色已更新。');
    } else if (button.dataset.act === 'status') {
      const status = user.status === 'active' ? 'disabled' : 'active';
      const body = await (await api('/api/users/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify({ status }) })).json();
      if (body.error) { flash('err', esc(body.error)); return; }
      flash('ok', esc(name) + ' 已' + (status === 'active' ? '启用' : '禁用') + '，其登录会话已失效。');
    } else if (button.dataset.act === 'del') {
      const purge = confirm('确认删除用户 ' + name + ' ？\\n\\n点击「确定」删除账号但保留其空间目录；\\n点击「取消」放弃本次删除。');
      if (!purge) return;
      const body = await (await api('/api/users/' + encodeURIComponent(name) + '?purge=false', { method: 'DELETE' })).json();
      if (body.error) { flash('err', esc(body.error)); return; }
      flash('ok', '已删除 ' + esc(name) + '。' + (body.spaceDirKept ? '其空间目录保留在 <span class="mono">' + esc(body.spaceDirKept) + '</span>。' : ''));
    }
    await loadUsers();
  } catch (error) {
    flash('err', '操作失败：' + esc(error.message));
  } finally {
    button.disabled = false;
  }
});

$('c-submit').addEventListener('click', async () => {
  const payload = {
    username: $('c-user').value.trim(),
    password: $('c-pass').value,
    role: $('c-role').value,
    status: $('c-status').value,
    note: $('c-note').value,
  };
  if (!payload.username) { flash('err', '请填写用户名。'); return; }
  $('c-submit').disabled = true;
  try {
    const body = await (await api('/api/users', { method: 'POST', body: JSON.stringify(payload) })).json();
    if (body.error) { flash('err', esc(body.error)); return; }
    flash('ok', '用户 <b>' + esc(payload.username) + '</b> 已创建'
      + (body.generatedPassword ? '，初始密码：<span class="pw">' + esc(body.generatedPassword) + '</span>（请立即保存，仅显示一次）' : '')
      + '。');
    $('c-user').value = ''; $('c-pass').value = ''; $('c-note').value = '';
    await loadUsers();
  } catch (error) {
    flash('err', '创建失败：' + esc(error.message));
  } finally {
    $('c-submit').disabled = false;
  }
});

/* ── 批量导入 ────────────────────────────────────────────────────────────── */

/** Shared renderer: both import sources answer with the same report shape. */
function showImportResult(body) {
  const rows = (body.results ?? []).map((row) => '<tr><td class="mono">' + row.line + '</td><td class="mono">' + esc(row.input)
    + '</td><td>' + esc(row.status) + '</td><td>' + esc(row.message)
    + (row.generatedPassword ? ' <span class="pw">' + esc(row.generatedPassword) + '</span>' : '') + '</td></tr>').join('');
  const source = body.source
    ? '<p class="sub" style="margin:0 0 10px">来源：' + esc(String(body.source.format ?? '').toUpperCase())
      + (body.source.sheetName ? ' · 工作表「' + esc(body.source.sheetName) + '」' : '')
      + (body.source.headerUsed ? ' · 按列名识别表头' : ' · 无表头，按 A=用户名 B=密码 C=角色 D=备注 解析')
      + ' · 有效行 ' + body.source.dataRows
      + (body.source.ignoredRows ? ' · 忽略空行 ' + body.source.ignoredRows : '') + '</p>'
    : '';
  $('i-result').classList.remove('hide');
  $('i-result').innerHTML = '<h2>导入明细</h2>' + source
    + '<div class="scroll"><table><thead><tr><th>行</th><th>输入</th><th>结果</th><th>说明</th></tr></thead><tbody>'
    + rows + '</tbody></table></div>';
}

function summarize(body) {
  const s = body.summary ?? {};
  return '导入完成：新建 <b>' + (s.created ?? 0) + '</b>，更新 <b>' + (s.updated ?? 0) + '</b>，跳过 '
    + (s.skipped ?? 0) + '，失败 <b>' + (s.failed ?? 0) + '</b>。';
}

let importFile = null;
const FILE_HINT = '支持 .xlsx / .xlsm / .csv / .tsv（旧版 .xls 请先另存为 .xlsx 或 CSV）';

function setImportFile(file) {
  importFile = file ?? null;
  $('i-file-name').textContent = importFile === null
    ? FILE_HINT
    : '已选择：' + importFile.name + '（' + Math.max(1, Math.round(importFile.size / 1024)) + ' KB）';
  $('i-upload').disabled = importFile === null;
}

$('i-pick').addEventListener('click', () => { $('i-file').click(); });
$('i-file').addEventListener('change', () => { setImportFile($('i-file').files[0]); });
['dragenter', 'dragover'].forEach((name) => {
  $('i-drop').addEventListener(name, (event) => {
    event.preventDefault();
    $('i-drop').classList.add('hot');
  });
});
['dragleave', 'drop'].forEach((name) => {
  $('i-drop').addEventListener(name, (event) => {
    event.preventDefault();
    $('i-drop').classList.remove('hot');
  });
});
$('i-drop').addEventListener('drop', (event) => {
  const dropped = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
  if (dropped) setImportFile(dropped);
});

$('i-upload').addEventListener('click', async () => {
  if (importFile === null) { flash('err', '请先选择要导入的文件。'); return; }
  const options = '?defaultRole=' + encodeURIComponent($('i-role').value)
    + '&onExisting=' + encodeURIComponent($('i-existing').value)
    + '&filename=' + encodeURIComponent(importFile.name);
  const button = $('i-upload');
  button.disabled = true;
  flash('info', '正在解析并导入 <b>' + esc(importFile.name) + '</b>，账号较多时需要一点时间，请不要刷新页面。');
  try {
    // The file *is* the request body: no multipart envelope to parse, and the
    // browser sets content-type from the File, which the gateway ignores.
    const res = await fetch(BOOT.basePath + '/api/users/import/upload' + options, {
      method: 'POST',
      credentials: 'same-origin',
      body: importFile,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      flash('err', esc(body.error ?? ('导入失败（HTTP ' + res.status + '）')));
      if (body.results) showImportResult(body);
      return;
    }
    flash('ok', summarize(body));
    showImportResult(body);
    setImportFile(null);
    $('i-file').value = '';
    await loadUsers();
  } catch (error) {
    flash('err', '导入失败：' + esc(error.message));
  } finally {
    button.disabled = importFile === null;
  }
});

$('i-submit').addEventListener('click', async () => {
  const payload = {
    text: $('i-text').value,
    defaultRole: $('i-role').value,
    onExisting: $('i-existing').value,
  };
  if (!payload.text.trim()) { flash('err', '请粘贴要导入的账号。'); return; }
  $('i-submit').disabled = true;
  try {
    const body = await (await api('/api/users/import', { method: 'POST', body: JSON.stringify(payload) })).json();
    if (body.error) { flash('err', esc(body.error)); return; }
    flash('ok', summarize(body));
    showImportResult(body);
    await loadUsers();
  } catch (error) {
    flash('err', '导入失败：' + esc(error.message));
  } finally {
    $('i-submit').disabled = false;
  }
});

async function loadStatus() {
  try {
    const body = await (await api('/api/status')).json();
    if (body.error) { $('statusBox').innerHTML = '<span class="muted">' + esc(body.error) + '</span>'; return; }
    const rows = (body.instances ?? []).map((item) => '<tr><td><b>' + esc(item.username) + '</b></td><td class="mono">127.0.0.1:' + item.port + '</td>'
      + '<td><span class="tag ' + (item.alive ? 'active' : 'disabled') + '">' + (item.alive ? '运行中' : '已停止') + '</span></td>'
      + '<td>' + Math.round(item.idleMs / 1000) + 's</td><td class="mono">' + esc(item.homeDir) + '</td></tr>').join('');
    $('statusBox').innerHTML = '<div class="row" style="margin-bottom:14px;gap:18px">'
      + '<div><div class="muted" style="font-size:12px">网关</div><div class="mono">' + esc(body.gateway.listenHost) + ':' + body.gateway.listenPort + '</div></div>'
      + '<div><div class="muted" style="font-size:12px">用户总数</div><div class="mono">' + body.gateway.users + '</div></div>'
      + '<div><div class="muted" style="font-size:12px">在线登录会话</div><div class="mono">' + body.gateway.sessions + '</div></div>'
      + '<div><div class="muted" style="font-size:12px">运行中实例</div><div class="mono">' + (body.instances ?? []).length + '</div></div>'
      + '<div><div class="muted" style="font-size:12px">管理员空间</div><div class="mono">' + esc(body.gateway.adminHomeMode) + '</div></div></div>'
      + (rows ? '<div class="scroll"><table><thead><tr><th>用户</th><th>上游</th><th>状态</th><th>空闲</th><th>DSH_HOME</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
              : '<div class="empty">当前没有由网关托管的运行实例（普通用户首次访问时会自动启动）。</div>');
  } catch (error) {
    $('statusBox').innerHTML = '<span class="muted">读取失败：' + esc(error.message) + '</span>';
  }
}

$('refresh').addEventListener('click', () => { flash('', ''); loadUsers(); });
loadUsers();
</script>
</body></html>`
}

/**
 * Renders the "my account" page.
 *
 * Shown to ordinary users and, via `/mu/account`, to administrators as well —
 * it is the only place where an account changes *its own* password, which is
 * what the bootstrap flow points people at right after installation.
 */
export function accountPage({ basePath, user, apps = [], minPasswordLength = 8 }) {
  const boot = JSON.stringify({ basePath, minPasswordLength })
  const appList = apps.length === 0
    ? '<div class="empty">宿主尚未安装任何额外应用。</div>'
    : `<div class="row" style="gap:6px">${apps.map((name) => `<span class="tag user mono">${escapeHtml(name)}</span>`).join('')}</div>`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的账号 · DSH 多用户网关</title><style>${BASE_CSS}
@media(min-width:760px){.pwgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 14px}}
</style></head>
<body><div class="wrap">
  <h1>我的账号</h1>
  <p class="sub">这是你在本 DSH 网关上的独立空间。</p>
  <div class="card">
    <table>
      <tr><th style="width:150px">用户名</th><td><b>${escapeHtml(user.username)}</b></td></tr>
      <tr><th>角色</th><td><span class="tag ${escapeHtml(user.role)}">${escapeHtml(user.role)}</span></td></tr>
      <tr><th>状态</th><td><span class="tag ${escapeHtml(user.status)}">${escapeHtml(user.status)}</span></td></tr>
      <tr><th>空间模式</th><td>${escapeHtml(user.homeMode === 'host' ? 'host 实例（管理员）' : '独立 DSH 实例')}</td></tr>
      <tr><th>最后登录</th><td>${escapeHtml(formatBeijingTime(user.lastLoginAt))}</td></tr>
    </table>
  </div>

  <div class="card">
    <h2>可用应用</h2>
    <p class="sub" style="margin:0 0 10px">由管理员统一安装，你的账号可直接使用；各账号的数据彼此独立。</p>
    ${appList}
  </div>

  <div class="card">
    <h2>修改密码</h2>
    <div id="pw-flash"></div>
    <div class="pwgrid">
      <div style="margin-bottom:12px"><label for="pw-cur">当前密码</label>
        <input id="pw-cur" type="password" autocomplete="current-password"></div>
      <div style="margin-bottom:12px"><label for="pw-new">新密码（至少 ${minPasswordLength} 位）</label>
        <input id="pw-new" type="password" autocomplete="new-password"></div>
      <div style="margin-bottom:12px"><label for="pw-confirm">确认新密码</label>
        <input id="pw-confirm" type="password" autocomplete="new-password"></div>
    </div>
    <div class="row"><button id="pw-submit" type="button">修改密码</button>
      <span class="muted">修改后其他设备上的登录会失效，当前页面保持登录。</span></div>
  </div>

  <div class="row">
    <a class="btn" href="${escapeHtml(basePath)}/workspace">进入工作台</a>
    <a class="btn ghost" href="${escapeHtml(basePath)}/logout">退出登录</a>
  </div>
<script data-dsh-multi-user="account">(()=>{const C=${boot};
const q=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const flash=(kind,html)=>{q('pw-flash').innerHTML=html?'<div class="notice '+kind+'">'+html+'</div>':''};
q('pw-submit').addEventListener('click',async()=>{
  const currentPassword=q('pw-cur').value,newPassword=q('pw-new').value,confirmPassword=q('pw-confirm').value;
  flash('','');
  if(!currentPassword){flash('err','请输入当前密码。');return;}
  if(newPassword.length<C.minPasswordLength){flash('err','新密码至少需要 '+C.minPasswordLength+' 位。');return;}
  if(newPassword!==confirmPassword){flash('err','两次输入的新密码不一致。');return;}
  if(newPassword===currentPassword){flash('err','新密码不能与当前密码相同。');return;}
  const button=q('pw-submit');button.disabled=true;
  try{
    const res=await fetch(C.basePath+'/api/password',{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({currentPassword,newPassword,confirmPassword})});
    const body=await res.json().catch(()=>({}));
    if(!res.ok){flash('err',esc(body.error||('修改失败（HTTP '+res.status+'）')));return;}
    flash('ok','密码已修改。其他设备上的登录已失效，当前页面保持登录。');
    q('pw-cur').value='';q('pw-new').value='';q('pw-confirm').value='';
  }catch(error){flash('err','请求失败：'+esc(error.message));}
  finally{button.disabled=false;}
});
})();</script>
</div></body></html>`
}

/** Renders an operator-facing error page. */
export function errorPage({ title, detail, basePath }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head>
<body><div class="wrap">
  <h1>${escapeHtml(title)}</h1>
  <div class="card"><div class="notice err" style="white-space:pre-wrap">${escapeHtml(detail)}</div>
  <p class="sub" style="margin:12px 0 0">该用户的独立 DSH 实例未能启动。可查看网关日志了解详情，或联系管理员。</p>
  <div class="row"><a class="btn" href="${escapeHtml(basePath)}/workspace">重试</a>
  <a class="btn ghost" href="${escapeHtml(basePath)}/logout">退出登录</a></div></div>
</div></body></html>`
}

/** Renders a short "starting your instance" page (used when a spawn is slow). */
export function startingPage({ basePath, username }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="4">
<title>正在启动独立空间…</title><style>${BASE_CSS}</style></head>
<body><div class="center"><div class="box" style="max-width:430px;text-align:center">
  <p class="brand">正在为 ${escapeHtml(username)} 启动独立空间<small>首次访问需要初始化一个独立的 DSH 实例</small></p>
  <div style="height:16px"></div>
  <div class="notice info">通常需要 10–40 秒，页面会自动刷新。</div>
  <a class="btn" style="display:block;width:100%" href="${escapeHtml(basePath)}/workspace">立即重试</a>
</div></div></body></html>`
}

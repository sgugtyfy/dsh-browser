# dsh-browser —— DSH 原生浏览器控制插件

让 DSH 里的 AI **直接操作你本机已登录的 Chrome / Edge**：读页面、点按钮、填表单、执行 JS、截图。
登录态不是"复制过来"的，而是**同一份 profile 数据、实时同步**。

- **零依赖**：只用 Node 内置能力（`fetch` / `WebSocket`），不需要 `pnpm install`
- **可一键卸载**：`node uninstall.mjs`，摘除时只删链接，不动你的浏览器数据
- **可分享**：整个目录拷给别人，`node install.mjs` 即可（Windows / macOS 路径都适配）
- **顺带兼容 MCP**：`mcp/server.mjs` 能被 Claude Code、Codex 等任何 MCP 客户端挂载

---

## 从 GitHub 安装（分享给别人）

**方式一：DSH 里直接装（推荐）**
在侧边栏/设置里的「插件」页点 **添加插件**，粘贴仓库地址：

```
https://github.com/sgugtyfy/dsh-browser
```

DSH 会把它当作一个 bundle 用 pnpm 装进当前 profile；以后卸载也在同一个界面里点。

**方式二：克隆下来手动装**

```powershell
git clone https://github.com/sgugtyfy/dsh-browser.git
cd dsh-browser
node install.mjs --profile desktop
```

---

## 安装 / 卸载 / 验证

**最省事：双击 `install.cmd` / `uninstall.cmd`**（会自动找 node、跑完停住让你看结果）。

命令行等价写法：

```powershell
# 安装（默认 profile = desktop；用 --profile web 可装到 web profile）
node install.mjs --profile desktop

# 验证：先探活（不启动浏览器），再跑端到端自测（会真的启动浏览器，用你的真实 profile）
node mcp/server.mjs --selftest
node test/e2e.mjs            # 或 npm run test:e2e；测 edge 用 node test/e2e.mjs edge

# 卸载（保留浏览器链接）
node uninstall.mjs --profile desktop

# 卸载并清掉浏览器目录联接
node uninstall.mjs --profile desktop --purge

# 先看会改什么，不动手
node install.mjs --dry-run
node uninstall.mjs --dry-run
```

安装做三件事（幂等）：

1. `~/.dsh/plugins/dsh-browser` → 本目录（junction，"安装位"）
2. `<profile>/node_modules/dsh-browser` → 上面那个（Node 解析路径）
3. profile `package.json`：加 `link:` 依赖 + `dsh.profile.bundles` 条目（改前自动备份）

装完 DSH 会**热加载** profile 变更；如果没看到 `browser_*` 工具，重启一次 DSH 桌面端。

卸载只摘链接、只改 profile `package.json`，**绝不递归删除任何真实目录**；
遇到"不是链接的真实目录"只报告、不动手。

---

## 工具

| 工具 | 用途 |
|---|---|
| `browser_status` | 查两个浏览器的端口 / 版本 / 标签页数（排查第一步） |
| `browser_launch` | 启动浏览器并开好调试端口（`profile: real \| dedicated`，`restart: true` 可先关掉在跑的） |
| `browser_tabs` | 列出标签页，`active: true` 是用户正在看的那个 |
| `browser_open` | 打开网址（复用当前标签页 / 新开 / 后台新开不抢焦点） |
| `browser_read` | **读正文纯文本**（默认 6000 字符，省 token 主力） |
| `browser_eval` | **执行 JS 并只取需要的字段**（最省 token 的万能口） |
| `browser_act` | `click` / `type` / `press` / `scroll` / `wait`，选择器支持 CSS / XPath / `text=按钮文字` |
| `browser_close` | 关闭标签页（必须给 `tabId`） |
| `browser_screenshot` | 截图（很费 token，按需调用） |

### 为什么这套工具省 token

工具 schema 每次请求都会进上下文，工具返回值直接进对话——所以：

- **只有 9 个工具**（对比官方 `chrome-devtools-mcp` 的 26 个 × 2 个浏览器）
- **文本优先**：`browser_read` 返回正文而不是整棵无障碍树，`browser_eval` 让你只 `return` 需要的字段
- **截图按需**：默认不截，只有明确要看图时才调用

---

## 原理：怎么在保住登录态的同时开出调试端口

Chromium **136+** 有安全改动：`--user-data-dir` 指向**默认 profile 目录**时，
`--remote-debugging-port` 会被**静默丢弃**——参数收下了（连渲染子进程命令行里都带着），
但 DevTools 服务器根本不启动，端口永远不开。本机 Chrome 154.0.8037.58 实测复现。

网上常见的绕法是复制一份 profile，代价是登录态会和日常浏览器逐渐脱节。

**本插件的做法：目录联接（junction）。** 给同一个物理目录另起一个路径，再把它传给 `--user-data-dir`：

```
~/.dsh-browser-links/chrome-userdata
        └─(junction)─> %LOCALAPPDATA%\Google\Chrome\User Data
```

该检查是按**路径字符串**做的，换个写法就通过了。实测结果：

```
PORT 9333 OPEN => Chrome/154.0.8037.58  webSocketDebuggerUrl: ws://127.0.0.1:9333/devtools/browser/...
```

**数据是同一份**：你在日常浏览器里登录/退出的任何站点，AI 这边立刻是同一状态。

> 链接目录放在插件目录**之外**，是为了避免以后递归删除插件目录时误伤真实 profile。

### 代价（必须知道）

- Chromium 单实例 + profile 独占锁：**启动时必须先完全退出该浏览器**，两边不能同时开同一 profile。
- 开了调试端口后，**本机任何进程都能控制这个已登录的浏览器**（这正是 Chrome 当初封锁它的原因）。
  不用时建议关掉；想要隔离就用 `browser_launch` 的 `profile: "dedicated"`。

---

## 和用户同时用一个浏览器

用户可以照常开新标签页、切标签、打字、关标签——插件每次操作前都重新枚举标签页。

「我该操作哪个标签页」的判定（三层兜底）：

1. `document.hasFocus()` —— 最准；Chrome 窗口被别的窗口挡住时依然有效（实测）
2. `document.visibilityState === 'visible'` —— 窗口在前台时有效
3. 浏览器窗口标题匹配（`tasklist /v`，窗口标题即激活标签标题）

三层都判不出来时（多窗口等），**改页面的操作会直接拒绝**并列出所有标签页要求指定 `tabId`，
而不是跑到某个不确定的标签上乱点。`browser_tabs` 的 `active` 字段会显示判定结果。

---

## 也可以当 MCP 服务器用（给非 DSH 客户端）

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["C:\\Users\\86176\\Documents\\dsh插件库\\dsh-browser\\mcp\\server.mjs"]
    }
  }
}
```

同一份引擎、同一张工具表，所以两种用法行为完全一致。

---

## 目录结构

```
dsh-browser/
├── package.json          dsh.bundle.patch 指向自带的 patch（这是 DSH 插件的标准形态）
├── cordis.patch.yml      bundle patch：往 profile 插入插件 entry（卸载随 bundle 一起消失）
├── lib/
│   ├── cdp.js            浏览器控制引擎（CDP，零依赖）
│   ├── tools.js          工具表（单一真源，插件与 MCP 共用）
│   └── index.js          DSH 插件入口：apply() 里 ctx.tools.register(...)
├── mcp/server.mjs        MCP 适配器
├── test/e2e.mjs          端到端自测（装完/改完跑一遍）
├── install.mjs           安装
├── uninstall.mjs         卸载
└── launch-*.cmd          手动启动脚本（双击即可）
```

**为什么不用 `@deepseek-ai/dsh-tools` 的 `defineTool`**：官方 `defineTool` 做的是
「参数 DSL → JSON Schema + 参数校验」（读自 `app.asar` 里 `dsh-tools/lib/index.js`）。
本插件在 `lib/tools.js` 里实现了等价逻辑，于是不依赖任何包——第三方插件必须自带依赖
（`@deepseek-ai/*` 不会自动对插件可见），零依赖才能"拷到哪都能跑"。

---

## 排错

| 现象 | 处理 |
|---|---|
| 没有 `browser_*` 工具 | 重启 DSH 桌面端；看诊断日志 `%TEMP%\dsh-browser.log` 有没有 `apply()` 记录 |
| 端口开不出来 | 该浏览器必须**完全退出**后再 `browser_launch`；或传 `restart: true` |
| 9222 被占用 | 本插件默认用 9333/9334；可用 `DSH_CHROME_DEBUG_PORT` / `DSH_EDGE_DEBUG_PORT` 改 |
| 想换浏览器路径 | `DSH_CHROME_PATH` / `DSH_EDGE_PATH` |
| 想换默认 profile | `DSH_CHROME_PROFILE` / `DSH_EDGE_PROFILE` |
| 想换链接目录 | `DSH_BROWSER_LINK_ROOT` |
| 关掉诊断日志 | `DSH_BROWSER_DIAG=""` |

## 许可

MIT

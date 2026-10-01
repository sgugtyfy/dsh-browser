# dsh-browser —— DSH 浏览器桥

让 DSH 里的 AI **连上你自己开着远程调试端口的浏览器**：读页面、点按钮、填表单、执行 JS、截图。

**插件是「桥」，不是「浏览器管理器」**：你自己带 `--remote-debugging-port=<端口>` 启动 Chrome / Edge
（或双击仓库里的 `launch-chrome.cmd` / `launch-edge.cmd`），插件负责扫端口、连上去、把工具给 AI。
它**不需要知道**你用什么 profile，也不会去动你的浏览器数据。

> ⚠️ **历史事故，务必知道**：v0.1.0 曾用 junction（目录联接）把调试端口开在用户的**真实 profile** 上，
> 实测导致 Chromium **清空用户的 cookie**（登录态全丢、密码和站点数据不受影响）。该模式已在 v0.1.1 彻底移除，
> 现在插件只连你自己启动的浏览器。详见[下文](#️-关于用户真实-profile的重要警告)。

- **零依赖**：只用 Node 内置能力（`fetch` / `WebSocket`），不需要 `pnpm install`
- **不管 profile**：连哪个浏览器、用哪个 profile，完全由你启动时决定
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
| `browser_status` | **扫描调试端口，列出能连上的端点**（浏览器 / 版本 / 标签页数 / 该端点用的 user-data-dir） |
| `browser_launch` | 【可选】替你起一个带调试端口的浏览器（默认独立 profile，也能用 `userDataDir` 指定；指向主 profile 会被拒绝） |
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

## ⚠️ v0.1.1 起：不再使用你的真实 profile（必读）

**v0.1.0 的「用 junction 指向真实 profile」做法有破坏性，已被实测证明会清空用户 cookie，现予移除。**

Chromium **136+** 的改动：`--user-data-dir` 指向**默认 profile 目录**时，`--remote-debugging-port` 会被静默丢弃。
v0.1.0 曾用「目录联接（junction）换一种路径写法」绕过这个检查 —— 端口确实能开出来，但代价是：

**实测事故（Windows，Edge 154 + Chrome 154）**：用 junction 路径启动后，两个浏览器的 cookie 库都被大面积清空：

| profile | 文件大小 | 空闲页占比 | 剩余 cookie | 后果 |
|---|---|---|---|---|
| Edge `Profile 7` | 928 KB | **222/230（96%）** | 26 条 | 所有站点登录态丢失 |
| Chrome `Profile 1` | 576 KB | **128/137（93%）** | 41 条 | 同上 |
| *对照：Chrome `Profile 5`* | 84 KB | *1/21（5%，健康）* | *111 条* | *从未被 junction 启动过，完好* |

最后一行是最有力的旁证：同一个 Chrome 里，被 junction 启动过的 profile 被清空，
没被碰过的 profile 完全正常。

而密码库（Login Data，110 条）与站点数据（Local Storage 16 MB / IndexedDB 75 MB）**完好无损** ——
这正是 Chromium「cookie 解不开就直接删除」的行为特征：cookie 加密密钥与**用户数据目录路径**绑定，
换成 junction 的路径写法后解不开，于是被丢弃。

**所以 v0.1.1 做了三件事：**

1. `profile: "real"` 移除，调用会直接报错并说明原因
2. 唯一模式是 `profile: "dedicated"`（默认）：插件目录下的**独立 profile**
   （`<插件目录>/profiles/chrome`、`<插件目录>/profiles/edge`）
3. `browser_status` 会检测旧版本残留的 junction 并警告删除（`node uninstall.mjs --purge`）

### 「那 AI 还能操作我已登录的浏览器吗？」

能，但要用**不碰 profile 的方式**：写一个浏览器扩展做桥接（扩展跑在浏览器内部，通过本机 WebSocket
连到插件）。它完全不接触 `--user-data-dir`，因此没有任何 cookie 风险 —— 这是 v0.2 的计划。

在此之前，想让 AI 操作需要登录的站点：用插件启动的独立 profile 浏览器，**在里面登录一次**，
之后长期有效，且与你的日常浏览器互不影响。

### 其他代价

- 独立 profile 里**没有**你日常浏览器的登录态，需要重新登录一次（这是刻意的隔离）
- 开了调试端口后，**本机任何进程都能控制那个浏览器实例**（这正是 Chrome 当初封锁它的原因）。不用时建议关掉

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
| 想扫描别的端口 | `DSH_BROWSER_PORTS=9333,9222,8080`（逗号分隔） |
| 想换浏览器可执行文件 | `DSH_CHROME_PATH` / `DSH_EDGE_PATH` |
| 想换 `browser_launch` 的默认端口 | `DSH_CHROME_DEBUG_PORT` / `DSH_EDGE_DEBUG_PORT` |
| 想换独立 profile 的位置 | `DSH_BROWSER_PROFILE_ROOT` |
| 关掉诊断日志 | `DSH_BROWSER_DIAG=""` |

## 更新日志

- **v0.1.3**：修 `migrateLegacyProfile` 里 `renameSync` 未导入的 bug（触发迁移会 ReferenceError）；
  删除 junction 时代的死代码（`legacyJunctionExists` / `LINK_ROOT` / `linkProfile`）；
  自测脚本改为桥接模型（先扫端口发现端点，没有端点时只提示、不自动开浏览器）
- **v0.1.2**：改成「桥」——不再假定浏览器由插件启动，改为**扫描端口发现端点**（`browser` 参数可传
  `chrome` / `edge` / 端口号）；独立 profile 移到 `~/.dsh-browser-profiles/`（升级插件不再丢登录态，
  旧目录自动迁移）；`browser_launch` 支持 `port` / `userDataDir`，并**拒绝**指向浏览器主 profile 目录
- **v0.1.1**：移除 `profile:"real"`（junction 方案实测会清空用户 cookie）；默认且唯一使用独立 profile；
  `browser_status` 增加旧 junction 残留告警
- **v0.1.0**：首个版本

## 许可

MIT

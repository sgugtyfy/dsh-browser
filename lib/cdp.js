/**
 * cdp.js — 浏览器控制引擎（零依赖）
 *
 * 只依赖 Node 内置能力：global fetch / global WebSocket / node:child_process。
 * 被两处复用：
 *   - lib/index.js      DSH 原生插件（注册 browser_* 工具）
 *   - mcp/server.mjs    MCP 适配器（给 Claude Code / Codex 等非 DSH 客户端）
 *
 * 关键设计（都是在本机实测踩出来的）：
 *   1. Chromium 136+ 会拒绝「默认 profile 目录」的调试端口：参数收下、服务器不启动。
 *      解法是给同一目录建 junction，换一个路径写法通过检查 —— 数据仍是同一份，
 *      登录态是实时同步的，不是复制。
 *   2. 不指定标签页时，认「用户正在看的那个」：hasFocus → visibility → 窗口标题，三层兜底。
 *   3. 判断不出目标标签页时，改页面的操作宁可拒绝，也不在用户可能正在用的标签上乱点。
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();

/** junction 目录放在插件之外，避免递归删除插件目录时误伤真实 profile */
export const LINK_ROOT = process.env.DSH_BROWSER_LINK_ROOT || path.join(HOME, '.dsh-browser-links');

/** 9222 在很多机器上已被别的工具占用，所以默认用 9333/9334 */
export const BROWSERS = {
  chrome: {
    key: 'chrome',
    label: 'Chrome',
    port: Number(process.env.DSH_CHROME_DEBUG_PORT || 9333),
    exe:
      process.env.DSH_CHROME_PATH ||
      (process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    processName: 'chrome.exe',
    realProfile:
      process.platform === 'win32'
        ? path.join(HOME, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
        : path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome'),
    dedicatedProfile: path.join(PKG_ROOT, 'profiles', 'chrome'),
    linkProfile: path.join(LINK_ROOT, 'chrome-userdata'),
    profileDirName: process.env.DSH_CHROME_PROFILE || 'Default',
  },
  edge: {
    key: 'edge',
    label: 'Edge',
    port: Number(process.env.DSH_EDGE_DEBUG_PORT || 9334),
    exe:
      process.env.DSH_EDGE_PATH ||
      (process.platform === 'win32'
        ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    processName: 'msedge.exe',
    realProfile:
      process.platform === 'win32'
        ? path.join(HOME, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data')
        : path.join(HOME, 'Library', 'Application Support', 'Microsoft Edge'),
    dedicatedProfile: path.join(PKG_ROOT, 'profiles', 'edge'),
    linkProfile: path.join(LINK_ROOT, 'edge-userdata'),
    profileDirName: process.env.DSH_EDGE_PROFILE || 'Default',
  },
};

export class CdpError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertWebSocket() {
  if (typeof WebSocket !== 'function') {
    throw new CdpError(
      `当前运行环境没有全局 WebSocket（Node ${process.versions.node}）。` +
        `需要 Node ≥ 22，或改用 mcp/server.mjs 由独立进程承载。`,
    );
  }
}

async function getJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new CdpError(`HTTP ${res.status} ${url}`);
  return await res.json();
}

export function resolveBrowser(name) {
  if (!name) return null;
  const k = String(name).toLowerCase();
  if (k === 'chrome' || k === 'google') return BROWSERS.chrome;
  if (k === 'edge' || k === 'msedge') return BROWSERS.edge;
  throw new CdpError(`未知的 browser: ${name}（只支持 chrome / edge）`);
}

/** 探测调试端口；required=false 时返回 null 而不抛错 */
export async function endpoint(b, { required = true } = {}) {
  try {
    const v = await getJson(`http://127.0.0.1:${b.port}/json/version`, 2500);
    if (!v || !v.webSocketDebuggerUrl) throw new CdpError('不是 DevTools 端点');
    return v;
  } catch (e) {
    if (!required) return null;
    throw new CdpError(
      `${b.label} 的调试端口 ${b.port} 不可用（${e.message}）。` +
        `先调用 browser_launch 启动（browser:"${b.key}"），或双击插件目录里的 launch-${b.key}.cmd。`,
    );
  }
}

/** 没指定 browser 时挑一个活着的 */
async function pickBrowser(name) {
  const b = resolveBrowser(name);
  if (b) {
    await endpoint(b);
    return b;
  }
  for (const cand of [BROWSERS.chrome, BROWSERS.edge]) {
    if (await endpoint(cand, { required: false })) return cand;
  }
  throw new CdpError(
    `Chrome(${BROWSERS.chrome.port}) 和 Edge(${BROWSERS.edge.port}) 都没有可用的调试端口。` +
      `先调用 browser_launch 启动其中一个。`,
  );
}

async function listPages(b) {
  const list = await getJson(`http://127.0.0.1:${b.port}/json/list`, 4000);
  return (Array.isArray(list) ? list : []).filter((t) => t.type === 'page');
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端：一次操作一条连接，用完即关，天然不会留脏状态        */
/* ------------------------------------------------------------------ */

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new CdpError(msg.error.message || 'CDP error'));
        else resolve(msg.result);
      }
    });
    ws.addEventListener('error', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new CdpError('CDP 连接错误'));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl, timeoutMs = 10000) {
    assertWebSocket();
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError(`连接 CDP 超时: ${wsUrl}`)), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError(`无法连接 CDP: ${wsUrl}`));
      });
    });
    return new CdpSession(ws);
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 找「用户正在看」的标签页                                             */
/* ------------------------------------------------------------------ */

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 窗口标题形如 "页面标题 - Google Chrome" / "页面标题 - 个人 - Microsoft Edge" */
function matchByWindowTitle(b, pages) {
  if (process.platform !== 'win32') return null;
  let out = '';
  try {
    out = execFileSync('tasklist', ['/v', '/fi', `imagename eq ${b.processName}`, '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
  } catch {
    return null;
  }
  const titles = out
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => String(parseCsvLine(l).pop() || '').trim())
    .map((s) => {
      for (const suffix of ['Google Chrome', 'Microsoft Edge']) {
        const idx = s.lastIndexOf(' - ' + suffix);
        if (idx > 0) s = s.slice(0, idx).trim();
      }
      return s.replace(/ - (\u4E2A\u4EBA|Profile \d+|\u9ED8\u8BA4|Default)$/i, '').trim();
    })
    .filter((t) => t && t !== 'N/A' && t !== 'OleMainThreadWndName');

  for (const t of titles) {
    const hit = pages.find((p) => {
      const pt = String(p.title || '').trim();
      return pt && (pt === t || pt.startsWith(t) || t.startsWith(pt));
    });
    if (hit) return hit.id;
  }
  return null;
}

/**
 * 三层判据：Chrome 窗口被别的窗口盖住时 visibilityState 会全变 hidden（实测），
 * 所以 hasFocus 优先，窗口标题兜底。
 */
export async function activeTabIds(b, pages) {
  const probed = await Promise.allSettled(
    pages.slice(0, 15).map(async (p) => {
      const s = await CdpSession.connect(p.webSocketDebuggerUrl, 4000);
      try {
        const r = await s.send(
          'Runtime.evaluate',
          { expression: '({ vis: document.visibilityState, focus: document.hasFocus() })', returnByValue: true },
          4000,
        );
        return { id: p.id, ...(r?.result?.value || {}) };
      } finally {
        s.close();
      }
    }),
  );
  const rows = probed.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);

  const focused = rows.filter((r) => r.focus).map((r) => r.id);
  if (focused.length) return focused;

  const visible = rows.filter((r) => r.vis === 'visible').map((r) => r.id);
  if (visible.length) return visible;

  const byTitle = matchByWindowTitle(b, pages);
  return byTitle ? [byTitle] : [];
}

/**
 * 解析目标标签页。
 * requireExplicit=true 且判不出「用户在看的那个」时，多标签下直接拒绝 —— 改页面的操作
 * 不能猜。
 */
export async function resolveTab(b, tabId, { requireExplicit = false } = {}) {
  const pages = await listPages(b);
  if (!pages.length) throw new CdpError(`${b.label} 当前没有任何标签页`);
  if (tabId) {
    const hit =
      pages.find((p) => p.id === String(tabId)) || pages.find((p) => String(p.id).startsWith(String(tabId)));
    if (!hit) throw new CdpError(`找不到 tabId=${tabId}；先用 browser_tabs 看现有标签页`);
    return hit;
  }
  const active = await activeTabIds(b, pages);
  const hit = pages.find((p) => active.includes(p.id));
  if (hit) return hit;

  if (requireExplicit && pages.length > 1) {
    const list = pages
      .map((p, i) => `  [${i}] ${String(p.title || '').slice(0, 50)} — ${String(p.url || '').slice(0, 90)}\n      tabId=${p.id}`)
      .join('\n');
    throw new CdpError(
      `判断不出你正在看哪个标签页（浏览器可能在后台或多窗口）。当前有 ${pages.length} 个标签页，请指定 tabId：\n${list}`,
    );
  }
  return pages[0];
}

async function withPage(b, tabId, fn, opts) {
  const tab = await resolveTab(b, tabId, opts);
  const session = await CdpSession.connect(tab.webSocketDebuggerUrl);
  try {
    return await fn(session, tab);
  } finally {
    session.close();
  }
}

async function withBrowserWs(b, fn) {
  const ep = await endpoint(b);
  const session = await CdpSession.connect(ep.webSocketDebuggerUrl);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

/* ------------------------------------------------------------------ */
/* 页面内通用 JS 片段                                                  */
/* ------------------------------------------------------------------ */

const FIND_FN = `
function __vis(el){
  if(!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if(r.width <= 1 || r.height <= 1) return false;
  if(typeof el.checkVisibility === 'function') return el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true});
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
}
function __cands(){
  return Array.from(document.querySelectorAll('input,textarea,button,a,[role=button],[contenteditable=true]'))
    .filter(__vis).slice(0,12)
    .map(e => (e.tagName.toLowerCase() + (e.id ? '#'+e.id : '') + (e.placeholder ? '[placeholder="'+String(e.placeholder).slice(0,24)+'"]' : '') + ' ' + String(e.innerText||'').trim().slice(0,24)).trim());
}
function __find(sel){
  if(!sel) return null;
  const s = String(sel);
  if(s.startsWith('text=')){
    const want = s.slice(5).trim();
    const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,[role=button],[role=link],li,div,span,label,h1,h2,h3,h4,td,th,p'));
    const hit = (n) => String(n.innerText || n.value || '').trim();
    const exact = nodes.filter(n => hit(n) === want && __vis(n));
    if(exact.length) return exact[0];
    const loose = nodes.filter(n => hit(n).includes(want) && __vis(n));
    if(loose.length) return loose[0];
    const anyExact = nodes.filter(n => hit(n) === want);
    if(anyExact.length) return anyExact[0];
    const anyLoose = nodes.filter(n => hit(n).includes(want));
    return anyLoose[0] || null;
  }
  if(s.startsWith('/') || s.startsWith('(')){
    try{ const r = document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return r.singleNodeValue; }catch(e){ return null; }
  }
  try{
    // 可见性优先：很多站点会留一个隐藏的同名元素做兼容（例如百度首页的 #kw）
    const all = Array.from(document.querySelectorAll(s));
    return all.find(__vis) || all[0] || null;
  }catch(e){ return null; }
}
`;

async function evalRaw(session, expression, { awaitPromise = true } = {}) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new CdpError(`页面内 JS 抛错: ${d.exception?.description || d.text}`);
  }
  return r.result?.value;
}

/* ------------------------------------------------------------------ */
/* 对外的浏览器操作                                                     */
/* ------------------------------------------------------------------ */

export async function browserStatus({ browser } = {}) {
  const targets = browser ? [resolveBrowser(browser)] : [BROWSERS.chrome, BROWSERS.edge];
  const out = [];
  for (const b of targets) {
    const ep = await endpoint(b, { required: false });
    let pages = [];
    if (ep) {
      try {
        pages = await listPages(b);
      } catch {}
    }
    out.push({
      browser: b.key,
      label: b.label,
      port: b.port,
      debugReady: Boolean(ep),
      version: ep ? `${ep.Browser} (${ep['Protocol-Version'] || '?'})` : null,
      tabs: pages.length,
      exeExists: existsSync(b.exe),
      realProfile: b.realProfile,
      dedicatedProfile: b.dedicatedProfile,
      hint: ep ? null : `未开调试端口；调用 browser_launch({browser:"${b.key}"})`,
    });
  }
  return out;
}

function isProcessRunning(b) {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/fi', `imagename eq ${b.processName}`, '/nh', '/fo', 'csv'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    return /\.exe/i.test(out);
  } catch {
    return false;
  }
}

function killProcess(b) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/IM', b.processName, '/T'], { windowsHide: true, timeout: 20000, stdio: 'ignore' });
    } else {
      execFileSync('pkill', ['-f', b.exe], { windowsHide: true, timeout: 20000, stdio: 'ignore' });
    }
  } catch {}
}

/** 建/校验 junction 链接（指向真实 profile，绝不复制数据、绝不删除已有目录） */
export function ensureProfileLink(b) {
  mkdirSync(LINK_ROOT, { recursive: true });
  const link = b.linkProfile;
  let exists = false;
  try {
    exists = Boolean(lstatSync(link));
  } catch {
    exists = false;
  }
  if (!exists) {
    symlinkSync(b.realProfile, link, process.platform === 'win32' ? 'junction' : 'dir');
    return link;
  }
  let target = '';
  try {
    target = String(readlinkSync(link)).replace(/^\\\\\?\\/, '');
  } catch {
    target = '';
  }
  const same = process.platform === 'win32'
    ? path.resolve(target).toLowerCase() === path.resolve(b.realProfile).toLowerCase()
    : path.resolve(target) === path.resolve(b.realProfile);
  if (!same) {
    throw new CdpError(
      `链接目录 ${link} 已存在但指向的不是 ${b.realProfile}（实际: ${target || '未知'}）。请手工检查，我不会自动删除它。`,
    );
  }
  return link;
}

export async function launchBrowser({ browser, profile = 'real', profileDirectory, url, waitMs = 20000, restart = false } = {}) {
  const b = resolveBrowser(browser);
  const already = await endpoint(b, { required: false });
  if (already) {
    return {
      ok: true,
      alreadyRunning: true,
      browser: b.key,
      port: b.port,
      version: already.Browser,
      message: `${b.label} 已在 ${b.port} 上开着调试端口，直接可用。`,
    };
  }
  if (!existsSync(b.exe)) throw new CdpError(`找不到 ${b.label} 可执行文件：${b.exe}`);

  const running = isProcessRunning(b);
  if (running && !restart) {
    return {
      ok: false,
      browser: b.key,
      port: b.port,
      processRunning: true,
      message:
        `${b.label} 正在运行，但它不是用调试端口启动的。Chromium 是单实例：对已经在跑的浏览器再传参数会被忽略。` +
        `请先完全退出 ${b.label} 再重试；或调用 browser_launch 时传 restart:true 让我替你关掉它` +
        `（未保存的表单会丢，标签页一般能恢复）。`,
    };
  }
  if (running && restart) {
    killProcess(b);
    await sleep(2500);
  }

  const useReal = String(profile).toLowerCase() !== 'dedicated';
  const userDataDir = useReal ? ensureProfileLink(b) : b.dedicatedProfile;
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${b.port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (useReal || profileDirectory) args.push(`--profile-directory=${profileDirectory || b.profileDirName}`);
  if (url) args.push(url);

  const child = spawn(b.exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const deadline = Date.now() + Number(waitMs || 20000);
  while (Date.now() < deadline) {
    await sleep(500);
    const ep = await endpoint(b, { required: false });
    if (ep) {
      const pages = await listPages(b).catch(() => []);
      return {
        ok: true,
        browser: b.key,
        port: b.port,
        profileMode: useReal ? 'real' : 'dedicated',
        userDataDir,
        realProfile: useReal ? b.realProfile : null,
        version: ep.Browser,
        tabs: pages.length,
        message: useReal
          ? `${b.label} 调试端口已就绪，用的是你的真实 profile（同一份数据，登录态实时同步）。`
          : `${b.label} 调试端口已就绪（独立 profile）。`,
      };
    }
  }

  return {
    ok: false,
    browser: b.key,
    port: b.port,
    profileMode: useReal ? 'real' : 'dedicated',
    userDataDir,
    message: useReal
      ? `${b.label} 起来了但 ${b.port} 没有调试端口，且 junction 兜底也没生效，请把这条信息反馈给插件作者。`
      : `${b.label} 起来了但 ${b.port} 没有调试端口，请检查是否有安全软件拦截。`,
  };
}

export async function listTabs({ browser } = {}) {
  const b = await pickBrowser(browser);
  const pages = await listPages(b);
  const active = await activeTabIds(b, pages);
  return {
    browser: b.key,
    port: b.port,
    count: pages.length,
    note: 'active = 用户正在看的那个；判断不出来时全为 false',
    tabs: pages.map((p, i) => ({
      index: i,
      tabId: p.id,
      active: active.includes(p.id),
      title: (p.title || '').slice(0, 120),
      url: (p.url || '').slice(0, 300),
    })),
  };
}

export async function openUrl({ browser, url, tabId, newTab = false, background = false } = {}) {
  const b = await pickBrowser(browser);
  if (!url) throw new CdpError('缺少 url');

  if (!newTab) {
    const pages = await listPages(b);
    if (pages.length) {
      const tab = await resolveTab(b, tabId, { requireExplicit: true });
      await withPage(b, tab.id, async (s) => {
        await s.send('Page.enable').catch(() => {});
        await s.send('Page.navigate', { url }, 30000);
      });
      await sleep(700);
      return { ok: true, browser: b.key, tabId: tab.id, url, mode: 'current-tab' };
    }
  }
  const created = await withBrowserWs(b, (s) =>
    s.send('Target.createTarget', background ? { url, background: true } : { url }, 20000),
  );
  await sleep(700);
  return {
    ok: true,
    browser: b.key,
    tabId: created.targetId,
    url,
    mode: background ? 'new-tab-background（没抢焦点）' : 'new-tab',
  };
}

export async function closeTab({ browser, tabId } = {}) {
  const b = await pickBrowser(browser);
  const tab = await resolveTab(b, tabId, { requireExplicit: true });
  await withBrowserWs(b, (s) => s.send('Target.closeTarget', { targetId: tab.id }, 15000));
  return { ok: true, browser: b.key, closed: tab.id };
}

export async function readPage({ browser, tabId, maxChars = 6000, selector } = {}) {
  const b = await pickBrowser(browser);
  const limit = Math.max(200, Math.min(Number(maxChars) || 6000, 60000));
  return await withPage(b, tabId, async (s, tab) => {
    const rootExpr = selector
      ? `__find(${JSON.stringify(selector)})`
      : `(document.querySelector('article') || document.querySelector('main') || document.querySelector('[role=main]') || document.body)`;
    const expr = `(() => {
      ${FIND_FN}
      const root = ${rootExpr};
      if(!root) return { error: '找不到内容节点' };
      const text = (root.innerText || root.textContent || '').replace(/\\u00a0/g,' ').replace(/\\n{3,}/g,'\\n\\n').trim();
      return { title: document.title, url: location.href, totalChars: text.length, text: text.slice(0, ${limit}) };
    })()`;
    const r = await evalRaw(s, expr);
    if (r?.error) throw new CdpError(r.error);
    return {
      browser: b.key,
      tabId: tab.id,
      title: r.title,
      url: r.url,
      totalChars: r.totalChars,
      truncated: r.totalChars > limit,
      text: r.text,
    };
  });
}

export async function runJs({ browser, tabId, expression, awaitPromise = true } = {}) {
  const b = await pickBrowser(browser);
  if (!expression) throw new CdpError('缺少 expression');
  return await withPage(b, tabId, async (s, tab) => ({
    browser: b.key,
    tabId: tab.id,
    url: tab.url,
    result: await evalRaw(s, expression, { awaitPromise }),
  }));
}

export async function act({ browser, tabId, action, selector, text, value, ms } = {}) {
  const b = await pickBrowser(browser);
  const kind = String(action || '').toLowerCase();
  return await withPage(
    b,
    tabId,
    async (s, tab) => {
      const sel = JSON.stringify(selector || '');
      const findInfo = `(() => { ${FIND_FN} const el = __find(${sel}); if(!el) return {error:'找不到元素: ' + ${sel} + '；可交互候选: ' + __cands().join(' | ')}; el.scrollIntoView({block:'center', inline:'center'}); if(!__vis(el)) return {error:'元素存在但不可见: ' + ${sel} + '；可交互候选: ' + __cands().join(' | ')}; const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, tag: el.tagName, text: (el.innerText||el.value||'').slice(0,80) }; })()`;

      if (kind === 'click') {
        const info = await evalRaw(s, findInfo);
        if (info?.error) throw new CdpError(info.error);
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
        await sleep(300);
        return { ok: true, action: 'click', clicked: info, tabId: tab.id };
      }

      if (kind === 'type') {
        const info = await evalRaw(s, findInfo);
        if (info?.error) throw new CdpError(info.error);
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
        if (value === 'clear' || value === true) {
          await evalRaw(s, `(() => { ${FIND_FN} const el = __find(${sel}); if(el){ el.focus(); el.select && el.select(); } return true })()`);
          await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
          await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        }
        await s.send('Input.insertText', { text: String(text ?? '') });
        await sleep(200);
        return { ok: true, action: 'type', typed: String(text ?? '').slice(0, 200), into: info, tabId: tab.id };
      }

      if (kind === 'press') {
        const keyMap = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8 };
        const key = String(text || 'Enter');
        const vk = keyMap[key] ?? 13;
        await s.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          code: key,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
          text: key === 'Enter' ? '\r' : undefined,
        });
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await sleep(200);
        return { ok: true, action: 'press', key, tabId: tab.id };
      }

      if (kind === 'scroll') {
        const dy = Number(value ?? 800);
        await evalRaw(s, `(() => { window.scrollBy(0, ${dy}); return window.scrollY })()`);
        await sleep(200);
        return { ok: true, action: 'scroll', dy, tabId: tab.id };
      }

      if (kind === 'wait') {
        const waitMs = Math.min(Number(ms ?? value ?? 1500), 30000);
        await sleep(waitMs);
        return { ok: true, action: 'wait', ms: waitMs, tabId: tab.id };
      }

      throw new CdpError(`不支持的 action: ${action}（支持 click / type / press / scroll / wait）`);
    },
    { requireExplicit: true },
  );
}

export async function screenshot({ browser, tabId, fullPage = false } = {}) {
  const b = await pickBrowser(browser);
  return await withPage(b, tabId, async (s, tab) => {
    const shot = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(fullPage) }, 30000);
    return { browser: b.key, tabId: tab.id, url: tab.url, base64: shot.data };
  });
}

/** 自检：打印两个浏览器的状态（CLI 与排错用） */
export async function selftest(log = console.log) {
  const status = await browserStatus();
  log(JSON.stringify(status, null, 2));
  for (const b of [BROWSERS.chrome, BROWSERS.edge]) {
    if (await endpoint(b, { required: false })) {
      try {
        const pages = await listPages(b);
        if (pages.length) {
          const r = await readPage({ browser: b.key, tabId: pages[0].id, maxChars: 400 });
          log(`\n[${b.label}] 读取成功：${r.title} | ${r.url} | ${r.totalChars} chars`);
        }
      } catch (e) {
        log(`[${b.label}] 读取失败：${e.message}`);
      }
    }
  }
}

/**
 * tools.js — 工具表（单一真源）
 *
 * 同一份定义同时被两处消费：
 *   - lib/index.js     DSH 原生插件（ctx.tools.register）
 *   - mcp/server.mjs   MCP 适配器（tools/list、tools/call）
 *
 * 约定：
 *   parameters  作者 DSL：{ 字段名: { type, required?, description?, enum? } }
 *               toJsonSchema() 转成两边都能吃的 JSON Schema（官方 defineTool 的产出形状）。
 *   run(args)   返回「声明在 output.schema 里的值」——文本工具直接返回展示用字符串，
 *               截图工具返回 { tabId, url, file, data }，由 render 变成内容块。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cdp from './cdp.js';

const BROWSER_PARAM = {
  type: 'string',
  enum: ['chrome', 'edge'],
  description: '哪个浏览器；省略则自动挑当前开着调试端口的那个',
};
const TAB_PARAM = {
  type: 'string',
  description: '标签页 id（来自 browser_tabs）；省略则用用户正在看的那个标签页',
};

/** 作者 DSL → JSON Schema（官方 defineTool 的产出形状） */
export function toJsonSchema(parameters) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    const { required: isRequired, ...rest } = spec ?? {};
    properties[key] = rest;
    if (isRequired) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/** 轻量参数校验：必填缺失 / 枚举越界时给出模型看得懂的错误 */
export function validateArgs(parameters, args = {}) {
  const missing = Object.entries(parameters ?? {})
    .filter(([key, spec]) => spec?.required && (args[key] === undefined || args[key] === null || args[key] === ''))
    .map(([key]) => key);
  if (missing.length) return `缺少必填参数: ${missing.join(', ')}`;
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (args[key] === undefined || !Array.isArray(spec?.enum)) continue;
    if (!spec.enum.includes(args[key])) {
      return `参数 ${key} 只能是 ${spec.enum.join(' / ')}，收到的是 ${JSON.stringify(args[key])}`;
    }
  }
  return null;
}

const json = (v) => JSON.stringify(v, null, 2);
const TEXT_OUT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };

export const TOOLS = [
  {
    name: 'browser_status',
    description: '查看 Chrome / Edge 的调试端口、版本和标签页数量。排查浏览器问题时先调用它。',
    parameters: { browser: BROWSER_PARAM },
    output: TEXT_OUT,
    run: async (args) => json(await cdp.browserStatus(args)),
  },
  {
    name: 'browser_launch',
    description:
      '启动浏览器并开好调试端口（Chrome 9333 / Edge 9334），使用插件自带的**独立 profile**（首次需在里面登录一次，之后长期保留）。' +
      '注意：v0.1.0 曾提供「使用用户真实 profile」模式，实测它会导致 Chromium 清空用户 cookie（登录态全丢），已在 v0.1.1 移除，传 profile:"real" 会直接报错。' +
      '若浏览器已在运行但没带调试端口会返回提示；传 restart:true 可先关掉它再启动。',
    parameters: {
      browser: { ...BROWSER_PARAM, required: true, description: '要启动哪个浏览器' },
      profile: { type: 'string', enum: ['dedicated'], description: '只能用 dedicated（独立 profile）；"real" 因会清空 cookie 已移除' },
      profileDirectory: { type: 'string', description: '可选，如 "Profile 1" / "Profile 7"' },
      url: { type: 'string', description: '可选，启动后打开这个网址' },
      waitMs: { type: 'number', description: '等待端口就绪的毫秒数，默认 20000' },
      restart: { type: 'boolean', description: 'true = 先结束已在运行的该浏览器再启动（默认 false）' },
    },
    timeoutMs: 60000,
    output: TEXT_OUT,
    run: async (args) => json(await cdp.launchBrowser(args)),
  },
  {
    name: 'browser_tabs',
    description:
      '列出标签页（tabId / 标题 / URL）。active=true 的是用户正在看的那个；用户随时可以自己开新标签页，本工具每次都会重新枚举。',
    parameters: { browser: BROWSER_PARAM },
    output: TEXT_OUT,
    run: async (args) => json(await cdp.listTabs(args)),
  },
  {
    name: 'browser_open',
    description:
      '打开网址：默认复用用户正在看的那个标签页导航（多标签且判断不出目标时会拒绝并要求 tabId）；' +
      'newTab:true 新开标签页，background:true 时不抢用户焦点。',
    parameters: {
      url: { type: 'string', required: true },
      browser: BROWSER_PARAM,
      tabId: TAB_PARAM,
      newTab: { type: 'boolean', description: '是否新开标签页，默认 false' },
      background: { type: 'boolean', description: 'newTab 时 true = 后台打开，不打断用户' },
    },
    timeoutMs: 60000,
    output: TEXT_OUT,
    run: async (args) => json(await cdp.openUrl(args)),
  },
  {
    name: 'browser_read',
    description:
      '读取页面正文纯文本（自动优先 article/main），返回标题、URL 和正文。默认最多 6000 字符，是省 token 的主力工具；' +
      '内容很长时先用 browser_eval 只取需要的字段。',
    parameters: {
      browser: BROWSER_PARAM,
      tabId: TAB_PARAM,
      selector: { type: 'string', description: '可选 CSS 选择器 / XPath / "text=某文字"，限定读取范围' },
      maxChars: { type: 'number', description: '最多返回多少字符，默认 6000' },
    },
    output: TEXT_OUT,
    run: async (args) => {
      const r = await cdp.readPage(args);
      const limit = Number(args.maxChars) || 6000;
      return `${r.title}\n${r.url}\n(${r.totalChars} 字符${r.truncated ? `，已截断到 ${limit}` : ''})\n\n${r.text}`;
    },
  },
  {
    name: 'browser_eval',
    description:
      '在页面里执行一段 JS 并返回结果（支持 await）。最省 token 的万能口：只 return 你真正需要的那点数据，而不是把整页拉回来。',
    parameters: {
      expression: { type: 'string', required: true, description: 'JS 表达式或 IIFE，例如 (() => document.title)()' },
      browser: BROWSER_PARAM,
      tabId: TAB_PARAM,
      awaitPromise: { type: 'boolean', description: '默认 true' },
    },
    output: TEXT_OUT,
    run: async (args) => {
      const r = await cdp.runJs(args);
      let rendered;
      try {
        rendered = json(r.result);
      } catch {
        rendered = String(r.result);
      }
      return `${r.url}\n\n${rendered}`;
    },
  },
  {
    name: 'browser_act',
    description:
      '操作页面：click / type / press / scroll / wait。selector 支持 CSS、XPath 或 "text=按钮文字"；' +
      '找不到或元素不可见时会列出页面上可交互的候选元素。改页面的操作必须能确定目标标签页，否则会被拒绝。',
    parameters: {
      action: { type: 'string', enum: ['click', 'type', 'press', 'scroll', 'wait'], required: true },
      browser: BROWSER_PARAM,
      tabId: TAB_PARAM,
      selector: { type: 'string', description: 'click / type 必填' },
      text: { type: 'string', description: 'type 时输入的文字；press 时为按键名（默认 Enter）' },
      value: { type: 'string', description: 'type 时传 "clear" 先清空；scroll 时为像素数' },
      ms: { type: 'number', description: 'wait 的毫秒数' },
    },
    output: TEXT_OUT,
    run: async (args) => json(await cdp.act(args)),
  },
  {
    name: 'browser_close',
    description: '关闭指定标签页（必须给 tabId；插件不会关闭用户自己开的标签页）。',
    parameters: { browser: BROWSER_PARAM, tabId: TAB_PARAM },
    output: TEXT_OUT,
    run: async (args) => json(await cdp.closeTab(args)),
  },
  {
    name: 'browser_screenshot',
    description: '对标签页截图。图像会直接附在结果里；很费 token，只在确实需要看图时调用。',
    parameters: {
      browser: BROWSER_PARAM,
      tabId: TAB_PARAM,
      fullPage: { type: 'boolean', description: '默认 false，只截可视区域' },
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          url: { type: 'string' },
          file: { type: 'string', description: '落盘的 PNG 绝对路径' },
          data: { type: 'string', description: 'base64 PNG' },
        },
        required: ['data'],
      },
      render: (_args, value) => [
        { type: 'image', data: value.data, mimeType: 'image/png' },
        { type: 'text', text: `${value.url}\n（截图已同时落盘：${value.file}）` },
      ],
    },
    run: async (args) => {
      const shot = await cdp.screenshot(args);
      let file = '(落盘失败)';
      try {
        const dir = path.join(os.tmpdir(), 'dsh-browser-shots');
        fs.mkdirSync(dir, { recursive: true });
        file = path.join(dir, `shot-${Date.now()}.png`);
        fs.writeFileSync(file, Buffer.from(shot.base64, 'base64'));
      } catch {}
      return { tabId: shot.tabId, url: shot.url, file, data: shot.base64 };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

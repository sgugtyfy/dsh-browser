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
  description: '哪个端点：chrome / edge / 端口号（如 "9333"）；省略则用发现的第一个端点',
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
    description:
      '扫描本机调试端口（默认 9333/9334/9222/9223/9225/9229），列出当前能连上的浏览器端点：' +
      '浏览器类型、版本、标签页数、以及该端点实际使用的 user-data-dir。排查浏览器连接问题时先调用它。',
    parameters: { browser: BROWSER_PARAM },
    output: TEXT_OUT,
    run: async (args) => json(await cdp.browserStatus(args)),
  },
  {
    name: 'browser_launch',
    description:
      '【可选】替你启动一个带调试端口的浏览器。插件本身只是「桥」—— 你也可以自己带 --remote-debugging-port 启动浏览器，' +
      '再用 browser_status 连上去，那这个工具就不用调。默认用插件自带的独立 profile（~/.dsh-browser-profiles/<browser>，首次需在里面登录一次）；' +
      '也可以用 userDataDir 指定别的目录。指向浏览器主 profile 目录会被拒绝：那边端口开不出来，而用 junction 绕过会清空 cookie（实测事故，登录态全丢）。',
    parameters: {
      browser: { type: 'string', enum: ['chrome', 'edge'], required: true, description: '启动哪个浏览器' },
      port: { type: 'number', description: '调试端口，默认 9333(Chrome) / 9334(Edge)' },
      userDataDir: { type: 'string', description: '可选：自定义 user-data-dir；省略则用插件自带的独立 profile' },
      profileDirectory: { type: 'string', description: '可选，如 "Profile 1"' },
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

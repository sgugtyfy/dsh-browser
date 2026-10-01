#!/usr/bin/env node
/**
 * mcp/server.mjs — MCP 适配器（给 DSH 之外的客户端用）
 *
 * 同一个引擎（../lib/cdp.js）、同一张工具表（../lib/tools.js），
 * 所以用 DSH 插件还是用 MCP，行为完全一致。
 *
 * 在 Claude Code / Codex 等客户端里的注册示例：
 *   {
 *     "mcpServers": {
 *       "browser": { "command": "node", "args": ["<本文件绝对路径>"] }
 *     }
 *   }
 *
 * 用法：
 *   node server.mjs              # 作为 MCP server（stdio，换行分隔 JSON-RPC）
 *   node server.mjs --selftest   # 自检：打印两个浏览器状态，并试读当前页
 */
import { createRequire } from 'node:module';
import { TOOLS, toJsonSchema, validateArgs } from '../lib/tools.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

const CALL_TIMEOUT_MS = 120000;
const PROTOCOL_FALLBACK = '2024-11-05';

function log(...a) {
  process.stderr.write('[dsh-browser-mcp] ' + a.join(' ') + '\n');
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (t) => [{ type: 'text', text: String(t) }];

async function callTool(id, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return fail(id, -32602, `未知工具: ${name}`);
  const bad = validateArgs(tool.parameters, args ?? {});
  if (bad) return ok(id, { content: text(`错误：${bad}`), isError: true });

  let timer;
  try {
    const value = await Promise.race([
      tool.run(args ?? {}),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`工具 ${name} 超过 ${CALL_TIMEOUT_MS}ms 未返回`)), CALL_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    return ok(id, { content: tool.output.render(args ?? {}, value) });
  } catch (e) {
    clearTimeout(timer);
    log('tool error', name, e?.message ?? e);
    return ok(id, { content: text(`错误：${e?.message ?? e}`), isError: true });
  }
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_FALLBACK,
      capabilities: { tools: {} },
      serverInfo: { name: 'browser', version: VERSION },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') {
    return ok(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toJsonSchema(t.parameters),
      })),
    });
  }
  if (method === 'tools/call') return callTool(id, params?.name, params?.arguments);
  if (id !== undefined) fail(id, -32601, `未实现的方法: ${method}`);
}

function serveStdio() {
  let buf = '';
  const inflight = new Set();
  const track = (p) => {
    const t = Promise.resolve(p)
      .catch((e) => log('handler crash', e?.stack || String(e)))
      .finally(() => inflight.delete(t));
    inflight.add(t);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        track(handleMessage(JSON.parse(line)));
      } catch {
        log('无法解析的输入行', line.slice(0, 200));
      }
    }
  });
  // stdin 关闭后先把在飞调用做完，再让事件循环自然退出（不能 process.exit，会丢未 flush 的响应）
  process.stdin.on('end', async () => {
    await Promise.allSettled([...inflight]);
    process.exitCode = 0;
  });
  log(`stdio MCP 就绪 v${VERSION}（${TOOLS.length} 个工具，node ${process.versions.node}）`);
}

if (process.argv.includes('--selftest')) {
  const cdp = await import('../lib/cdp.js');
  cdp.selftest().then(
    () => process.exit(0),
    (e) => {
      console.error('selftest 失败:', e?.stack || e);
      process.exit(1);
    },
  );
} else {
  serveStdio();
}

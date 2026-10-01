/**
 * dsh-browser — DSH 原生浏览器控制插件
 *
 * 把 browser_* 工具注册进 DSH，直接通过 CDP 操作你本机**已登录**的 Chrome / Edge。
 * 零依赖：只用 Node 内置能力，不需要 pnpm install，也不需要额外的 MCP 进程。
 *
 * 与 DSH 的对接（读自 app.asar 里的 @deepseek-ai/dsh-tools）：
 *   ctx.tools.register({ name, description, parameters(JSON Schema),
 *                        output: { schema, render }, timeoutMs?, execute })
 * 官方 defineTool() 做的是「参数 DSL → JSON Schema + 参数校验」；本插件自带等价实现
 * （tools.js 的 toJsonSchema/validateArgs），因此不依赖 @deepseek-ai/dsh-tools，
 * 拷到任何机器上都能跑。
 *
 * 支持的 JSON Schema 子集（官方校验器的限制）：
 *   type / oneOf / properties / required / additionalProperties / items / enum / const + 注解
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, toJsonSchema, validateArgs } from './tools.js';

export const name = 'dsh-browser';
export const inject = ['tools'];
export const VERSION = '0.1.1';

const DIAG = process.env.DSH_BROWSER_DIAG ?? path.join(os.tmpdir(), 'dsh-browser.log');

function diag(msg) {
  if (!DIAG) return;
  try {
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export function apply(ctx, config = {}) {
  diag(
    `apply() v${VERSION} node=${process.versions.node} electron=${process.versions.electron ?? '-'} ` +
      `WebSocket=${typeof WebSocket} config=${JSON.stringify(config)}`,
  );

  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    diag('ctx.tools 不可用');
    throw new Error('dsh-browser: 需要 ctx.tools 服务（inject: ["tools"]）');
  }

  for (const tool of TOOLS) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.parameters),
      output: tool.output,
      ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
      async execute(args) {
        const bad = validateArgs(tool.parameters, args ?? {});
        if (bad) throw new Error(bad);
        return tool.run(args ?? {});
      },
    });
  }

  diag(`已注册 ${TOOLS.length} 个工具: ${TOOLS.map((t) => t.name).join(', ')}`);
  console.log(`[dsh-browser] active v${VERSION}（${TOOLS.length} 个工具，node ${process.versions.node}）`);
}

export default { name, inject, apply };

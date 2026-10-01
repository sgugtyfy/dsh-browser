#!/usr/bin/env node
/**
 * test/e2e.mjs — 端到端自测（桥接模式）
 *
 * 1) 扫描候选端口，列出发现的调试端点
 * 2) 挑一个端点做：列标签页 → 后台新开标签 → 读正文 → 执行 JS → 截图 → 关掉测试标签
 * 3) 一个端点都没有时只提示怎么启动，**不会**替你开浏览器
 *
 * 用法：
 *   node test/e2e.mjs                 # 用发现的第一个端点
 *   node test/e2e.mjs edge            # 指定 edge
 *   node test/e2e.mjs 9334            # 指定端口
 *   npm run test:e2e
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cdp from '../lib/cdp.js';

const target = process.argv[2];
let failed = 0;
const ok = (label, v) => console.log(`  ✓ ${label}: ${v}`);
const bad = (label, v) => {
  console.log(`  ✗ ${label}: ${v}`);
  failed++;
};

console.log('\n=== dsh-browser 端到端自测（桥接模式）===');

// 1) 端口发现
const found = await cdp.discover();
console.log(`扫描端口: ${cdp.PORTS.join(', ')}  →  发现 ${found.length} 个端点`);
for (const f of found) console.log(`  - ${f.brand}@${f.port}  ${f.version}`);

if (!found.length) {
  console.log(
    '\n没有发现任何调试端点。请先自己启动浏览器（插件只负责连上去）：\n' +
      '  · 双击本目录的 launch-chrome.cmd / launch-edge.cmd，或\n' +
      '  · 手动加参数启动：--remote-debugging-port=9333（Chrome）/ 9334（Edge）\n' +
      '然后重新运行本自测。',
  );
  process.exit(1);
}

// 2) 选定端点
const status = await cdp.browserStatus(target ? { browser: target } : {});
const ep = status.endpoints[0];
if (!ep) {
  bad('选定端点', `找不到匹配 "${target}" 的端点`);
  process.exit(1);
}
ok('选定端点', `${ep.browser}@${ep.port}  user-data-dir=${ep.userDataDir ?? '(未知)'}`);

// 3) 基础操作
try {
  const tabs = await cdp.listTabs({ browser: String(ep.port) });
  ok('列标签页', `${tabs.count} 个，其中 active=${tabs.tabs.filter((t) => t.active).length}`);

  const open = await cdp.openUrl({ browser: String(ep.port), url: 'https://example.com/', newTab: true, background: true });
  ok('后台开标签（不抢焦点）', open.tabId);

  const read = await cdp.readPage({ browser: String(ep.port), tabId: open.tabId, maxChars: 200 });
  ok('读正文', `${read.title} | ${read.url} | ${read.totalChars} 字符`);

  const js = await cdp.runJs({ browser: String(ep.port), tabId: open.tabId, expression: '({ n: 1 + 1, h: document.title })' });
  ok('执行 JS', JSON.stringify(js.result));

  const shot = await cdp.screenshot({ browser: String(ep.port), tabId: open.tabId });
  const out = path.join(os.tmpdir(), 'dsh-browser-e2e.png');
  fs.writeFileSync(out, Buffer.from(shot.base64, 'base64'));
  ok('截图', `${Math.round((shot.base64.length * 3) / 4 / 1024)} KB PNG → ${out}`);

  await cdp.closeTab({ browser: String(ep.port), tabId: open.tabId });
  ok('关闭测试标签页', open.tabId);
} catch (e) {
  bad('操作失败', e.message);
}

console.log(failed ? `\n有 ${failed} 项失败。\n` : '\n全部通过。\n');
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * test/e2e.mjs — dsh-browser 端到端自测
 *
 * 直接驱动插件运行时用的同一份引擎（../lib/cdp.js），验证：
 *   启动(真实 profile + junction) → 列标签页 → 后台开标签 → 读正文 → 执行 JS → 截图 → 关标签
 *
 * 用法：
 *   node test/e2e.mjs            # 默认测 chrome
 *   node test/e2e.mjs edge       # 测 edge
 *   npm run test:e2e
 *
 * 注意：会真的启动浏览器（用你的真实 profile，登录态不受影响）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cdp from '../lib/cdp.js';

const which = (process.argv[2] || 'chrome').toLowerCase();
const ok = (label, v) => console.log(`  ✓ ${label}: ${v}`);
const bad = (label, v) => {
  console.log(`  ✗ ${label}: ${v}`);
  process.exitCode = 1;
};

console.log(`\n=== dsh-browser 端到端自测 (${which}) ===`);

const status = await cdp.browserStatus({ browser: which });
console.log('状态:', JSON.stringify(status[0]));

const launch = await cdp.launchBrowser({ browser: which });
if (launch.alreadyRunning) ok('调试端口', '已在运行');
else if (launch.ok) ok('启动', `${launch.version} profileMode=${launch.profileMode}`);
else {
  bad('启动失败', launch.message);
  process.exit(1);
}

const tabs = await cdp.listTabs({ browser: which });
ok('标签页', `${tabs.count} 个，其中 active=${tabs.tabs.filter((t) => t.active).length}`);

const open = await cdp.openUrl({ browser: which, url: 'https://example.com/', newTab: true, background: true });
ok('后台开标签（不抢焦点）', open.tabId);

const read = await cdp.readPage({ browser: which, tabId: open.tabId, maxChars: 200 });
ok('读正文', `${read.title} | ${read.url} | ${read.totalChars} 字符`);

const js = await cdp.runJs({ browser: which, tabId: open.tabId, expression: '({ n: 1 + 1, h: document.title })' });
ok('执行 JS', JSON.stringify(js.result));

const shot = await cdp.screenshot({ browser: which, tabId: open.tabId });
const bytes = Math.round((shot.base64.length * 3) / 4);
const out = path.join(os.tmpdir(), 'dsh-browser-e2e.png');
fs.writeFileSync(out, Buffer.from(shot.base64, 'base64'));
ok('截图', `${bytes} bytes PNG → ${out}`);

await cdp.closeTab({ browser: which, tabId: open.tabId });
ok('关闭测试标签页', open.tabId);

console.log(process.exitCode ? '\n有失败项。\n' : '\n全部通过。\n');

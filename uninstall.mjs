#!/usr/bin/env node
/**
 * uninstall.mjs — 把 dsh-browser 从 DSH profile 里干净摘掉
 *
 * 默认只做「摘除」，不碰你的浏览器数据：
 *   1. profile package.json：删掉 dsh-browser 的 dependency 与 bundles 条目（改前自动备份）
 *   2. <profile>/node_modules/dsh-browser  链接（只删链接本身）
 *   3. ~/.dsh/plugins/dsh-browser          链接（只删链接本身）
 *
 * 加 --purge 再顺手删掉给浏览器用的两个目录联接
 * （~/.dsh-browser-links/chrome-userdata、edge-userdata —— 只是链接，你的真实
 *   Chrome / Edge profile 数据一个字节都不会动）。
 *
 * 安全红线：任何一步遇到「不是链接的真实目录」都只报告、绝不递归删除。
 *
 * 用法：
 *   node uninstall.mjs [--profile desktop] [--dsh-home <dir>] [--purge] [--dry-run]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const BUNDLE_NAME = PKG.name;

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const DRY = argv.includes('--dry-run');
const PURGE = argv.includes('--purge');
const DSH_HOME = String(flag('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
const PROFILE = String(flag('--profile', 'desktop'));
const LINK_ROOT = process.env.DSH_BROWSER_LINK_ROOT || path.join(os.homedir(), '.dsh-browser-links');

const log = (m) => console.log(`[uninstall] ${m}`);
const warn = (m) => console.warn(`[uninstall] ⚠️  ${m}`);
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);

function backupBeforeOverwrite(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
  } catch {
    return null;
  }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const snaps = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    for (const f of snaps.slice(0, Math.max(0, snaps.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
  return dest;
}

/** 只删链接本身（junction / symlink），绝不递归删内容 */
function removeLink(linkPath, label) {
  let st;
  try {
    st = fs.lstatSync(linkPath);
  } catch {
    log(`${label}: 不存在（已清理过）`);
    return false;
  }
  if (!st.isSymbolicLink()) {
    warn(`${label}: ${linkPath} 不是链接而是真实目录 —— 为避免误删，我不动它，请你确认后手工处理`);
    return false;
  }
  if (DRY) {
    log(`[dry-run] 将删除链接: ${linkPath}`);
    return true;
  }
  try {
    fs.rmdirSync(linkPath);
  } catch {
    try {
      fs.unlinkSync(linkPath);
    } catch (e) {
      warn(`${label}: 删除失败 ${e?.message ?? e}`);
      return false;
    }
  }
  log(`${label}: 已删除链接 ${linkPath}`);
  return true;
}

/* ------------------------------------------------------------------ */

log(`profile: ${PROFILE}    DSH_HOME: ${DSH_HOME}`);

// 1) profile package.json
const pkgFile = path.join(PROFILE_DIR, 'package.json');
if (fs.existsSync(pkgFile)) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch (e) {
    warn(`${pkgFile} 解析失败，跳过：${e.message}`);
    pkg = null;
  }
  if (pkg) {
    let changed = false;
    if (pkg.dependencies && Object.hasOwn(pkg.dependencies, BUNDLE_NAME)) {
      delete pkg.dependencies[BUNDLE_NAME];
      changed = true;
    }
    const bundles = pkg?.dsh?.profile?.bundles;
    if (Array.isArray(bundles) && bundles.includes(BUNDLE_NAME)) {
      pkg.dsh.profile.bundles = bundles.filter((b) => b !== BUNDLE_NAME);
      changed = true;
    }
    if (!changed) {
      log('profile package.json: 没有 dsh-browser 条目（已清理过）');
    } else if (DRY) {
      log(`[dry-run] 将从 ${pkgFile} 移除 dependency 与 bundles 条目`);
    } else {
      const backup = backupBeforeOverwrite(pkgFile);
      fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      log(`profile package.json: 已移除（备份: ${backup ? path.basename(backup) : '无'}）`);
    }
  }
} else {
  warn(`找不到 ${pkgFile}`);
}

// 2) profile 解析链接
removeLink(path.join(PROFILE_DIR, 'node_modules', BUNDLE_NAME), 'profile 解析链接');

// 3) 安装位链接
removeLink(path.join(DSH_HOME, 'plugins', BUNDLE_NAME), '安装位链接');

// 4) --purge：浏览器 junction
if (PURGE) {
  for (const [name, target] of [
    ['chrome-userdata', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')],
    ['edge-userdata', path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data')],
  ]) {
    const link = path.join(LINK_ROOT, name);
    if (fs.existsSync(link)) {
      log(`--purge: 处理 ${name}（指向 ${target}；只摘链接，真实 profile 不动）`);
      removeLink(link, `浏览器目录联接 ${name}`);
    }
  }
  try {
    if (!DRY && fs.existsSync(LINK_ROOT) && fs.readdirSync(LINK_ROOT).length === 0) {
      fs.rmdirSync(LINK_ROOT);
      log(`--purge: 已删除空目录 ${LINK_ROOT}`);
    }
  } catch {}
}

log('');
log('完成。DSH 会热加载 profile 变更；建议重启一次 DSH 桌面端确认 browser_* 工具已消失。');
log(`插件文件仍保留在: ${PKG_ROOT}`);
log('确实不再需要时，直接删掉这个目录即可（它已经不在 DSH 的加载路径上了）。');
if (!PURGE) {
  log(`提示：加 --purge 可一并清掉 ${LINK_ROOT} 下的浏览器目录联接。`);
}

#!/usr/bin/env node
/**
 * install.mjs — 把 dsh-browser 装进 DSH profile
 *
 * 做四件事（全部幂等，可重复执行）：
 *   1. ~/.dsh/plugins/dsh-browser        → 本插件目录（junction，"安装位"）
 *   2. <profile>/node_modules/dsh-browser → 上面那个（Node 解析路径；bundle patch 里的
 *      name: dsh-browser 就是按 profile 目录解析的）
 *   3. profile package.json：加 dependencies 的 link: 依赖 + dsh.profile.bundles 条目
 *   4. 可选：调 `dsh plugin --profile <p> install` 物化一遍（冷启动解析 bundle 需要）
 *
 * 另外顺手做一次历史迁移：删掉早期手工写进 profile cordis.patch.yml 的
 * "# === browser-mcp BEGIN/END ===" 区块（那是 MCP 版本的安装方式，与插件版功能重复）。
 *
 * 用法：
 *   node install.mjs [--profile desktop] [--dsh-home <dir>] [--dry-run] [--no-dsh-install]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const BUNDLE_NAME = PKG.name;

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const DRY = argv.includes('--dry-run');
const SKIP_DSH_INSTALL = argv.includes('--no-dsh-install');
const DSH_HOME = String(flag('--dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
const PROFILE = String(flag('--profile', 'desktop'));

const log = (m) => console.log(`[install] ${m}`);
const warn = (m) => console.warn(`[install] ⚠️  ${m}`);

function fatal(msg) {
  console.error(`[install] ERROR: ${msg}`);
  process.exit(1);
}

if (PROFILE === '.' || PROFILE === '..' || PROFILE === 'node_modules' || /[\\/\x00-\x1f<>:"|?*]/.test(PROFILE) || /[. ]$/.test(PROFILE)) {
  fatal(`profile 名不合法: ${JSON.stringify(PROFILE)}`);
}

const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
if (!fs.existsSync(PROFILE_DIR)) fatal(`找不到 profile 目录: ${PROFILE_DIR}`);

function backupBeforeOverwrite(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
  } catch (e) {
    warn(`备份失败（${file}）：${e?.message ?? e}；继续但请自行确认原内容`);
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

/** 由本插件管理的链接：已存在时校验指向，指向别处则重建（绝不删真实目录） */
function ensureDirLink(linkPath, targetDir, label) {
  if (!fs.existsSync(targetDir)) {
    // dry-run 下上一步的链接并未真的创建，这里不能当成错误
    if (DRY) {
      log(`[dry-run] 源目录尚未创建（上一步是 dry-run），跳过: ${targetDir}`);
      return linkPath;
    }
    fatal(`${label} 源目录不存在: ${targetDir}`);
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });

  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch (e) {
    if (e?.code !== 'ENOENT') fatal(`无法检查 ${label}: ${e?.message ?? e}`);
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      fatal(`${label} 已存在且不是链接/junction: ${linkPath}\n        请先手工移走或删除，再重跑本脚本（我不会动非链接的目录）。`);
    }
    let same = false;
    try {
      const a = fs.realpathSync(linkPath);
      const b = fs.realpathSync(targetDir);
      same = process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    } catch {}
    if (same) {
      log(`${label} 已存在且指向正确: ${linkPath}`);
      return linkPath;
    }
    log(`${label} 存在但指向别处，重建: ${linkPath}`);
    if (!DRY) removeLink(linkPath);
  }

  if (DRY) {
    log(`[dry-run] 将创建链接: ${linkPath} → ${targetDir}`);
    return linkPath;
  }
  fs.symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  log(`${label} 已创建: ${linkPath} → ${targetDir}`);
  return linkPath;
}

/** 只删链接本身：junction/符号链接用 rmdir 摘下，绝不递归进去删内容 */
export function removeLink(linkPath) {
  try {
    const st = fs.lstatSync(linkPath);
    if (!st.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  try {
    fs.rmdirSync(linkPath);
    return true;
  } catch {}
  try {
    fs.unlinkSync(linkPath);
    return true;
  } catch {}
  return false;
}

function patchProfilePackage(linkDir) {
  const pkgFile = path.join(PROFILE_DIR, 'package.json');
  let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      fatal(`无法解析 ${pkgFile}: ${e.message}`);
    }
  }
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) ? pkg.dependencies : {};
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];

  const linkVal = `link:${linkDir.replace(/\\/g, '/')}`;
  const before = JSON.stringify(pkg);
  pkg.dependencies[BUNDLE_NAME] = linkVal;
  if (!pkg.dsh.profile.bundles.includes(BUNDLE_NAME)) pkg.dsh.profile.bundles.push(BUNDLE_NAME);
  const after = JSON.stringify(pkg);
  if (before === after) {
    log(`profile package.json 已是最新（已含 ${BUNDLE_NAME}）`);
    return;
  }
  if (DRY) {
    log(`[dry-run] 将更新 ${pkgFile}: dependency ${BUNDLE_NAME} → ${linkVal}，bundles 追加 ${BUNDLE_NAME}`);
    return;
  }
  const backup = backupBeforeOverwrite(pkgFile);
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json 已更新${backup ? `（备份: ${path.basename(backup)}）` : ''}`);
}

/** 迁移：删掉早期手工写入的 MCP 版安装区块 */
function removeLegacyMcpBlock() {
  const patchFile = path.join(PROFILE_DIR, 'cordis.patch.yml');
  if (!fs.existsSync(patchFile)) return;
  const text = fs.readFileSync(patchFile, 'utf8');
  const BEGIN = '# === browser-mcp BEGIN ===';
  const END = '# === browser-mcp END ===';
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    if (/mcp-browser/.test(text)) {
      warn('profile patch 里仍有 mcp-browser 条目，但没有区块标记，未自动删除（请手工确认，避免与插件版的工具重复）');
    }
    return;
  }
  let cut = end + END.length;
  while (text[cut] === '\n' || text[cut] === '\r') cut++;
  const next = text.slice(0, start) + text.slice(cut);
  if (text === next) return;
  if (DRY) {
    log('[dry-run] 将删除 profile patch 里的旧 MCP 安装区块（browser-mcp BEGIN/END）');
    return;
  }
  const backup = backupBeforeOverwrite(patchFile);
  fs.writeFileSync(patchFile, next, 'utf8');
  log(`已移除旧 MCP 安装区块（备份: ${backup ? path.basename(backup) : '无'}）`);
}

function autoInstallBundles() {
  if (SKIP_DSH_INSTALL) {
    log('已跳过 `dsh plugin install`（--no-dsh-install）');
    return;
  }
  if (DRY) {
    log('[dry-run] 将执行: dsh plugin --profile ' + PROFILE + ' install');
    return;
  }
  const isWin = process.platform === 'win32';
  const cmd = isWin ? process.env.ComSpec || 'cmd.exe' : 'dsh';
  const args = isWin ? ['/d', '/v:off', '/s', '/c', 'dsh.cmd plugin --profile "%DSH_BROWSER_PROFILE%" install'] : ['plugin', '--profile', PROFILE, 'install'];
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    windowsVerbatimArguments: isWin,
    ...(isWin ? { env: { ...process.env, DSH_BROWSER_PROFILE: PROFILE } } : {}),
  });
  if (r.error || r.status !== 0) {
    log('未能自动执行 `dsh plugin install`（DSH 未在 PATH 上或返回非 0）。');
    log(`若 DSH 启动报 “cannot resolve profile bundle”，请手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  log('`dsh plugin install` 执行成功');
}

/* ------------------------------------------------------------------ */

log(`插件目录: ${PKG_ROOT}`);
log(`DSH_HOME : ${DSH_HOME}    profile: ${PROFILE}`);

for (const rel of ['lib/index.js', 'lib/cdp.js', 'lib/tools.js', 'cordis.patch.yml']) {
  if (!fs.existsSync(path.join(PKG_ROOT, rel))) fatal(`插件包不完整，缺少 ${rel}`);
}

const installedLink = ensureDirLink(path.join(DSH_HOME, 'plugins', BUNDLE_NAME), PKG_ROOT, `插件安装位 ${BUNDLE_NAME}`);
ensureDirLink(path.join(PROFILE_DIR, 'node_modules', BUNDLE_NAME), installedLink, `profile 解析链接 ${BUNDLE_NAME}`);
patchProfilePackage(installedLink);
removeLegacyMcpBlock();
autoInstallBundles();

log('');
log('完成。生效方式：DSH 会热加载 profile 变更；若没看到 browser_* 工具，重启一次 DSH 桌面端。');
log('自检：node ' + path.join(PKG_ROOT, 'mcp', 'server.mjs') + ' --selftest');
log('卸载：node ' + path.join(PKG_ROOT, 'uninstall.mjs'));

#!/usr/bin/env node

/**
 * deploy.js — 开发目录 → 本机安装目录 单向镜像同步
 *
 * 开发目录是本仓库的 408-mentor/（SKILL.md 所在目录）；
 * 安装目录默认 %USERPROFILE%\.dsh\skills\408-mentor（真实目录而非链接，
 * 若不同步，线上运行的永远是旧副本——SKILL.md 要求每次改动收尾必跑本脚本）。
 *
 * 镜像语义：让目标与源完全一致——
 *   1. 源有而目标缺失/过期（size 或 mtime 不同）→ 复制
 *   2. 目标多出来的文件 → 删除（镜像），但排除清单内的路径永不删除
 *   3. 排除清单（机器本地/运行时数据，不属于源代码资产）：
 *      - scripts/pdfcraft/venv/   Python 虚拟环境（约 200MB，安装侧按需 setup.bat 重建）
 *      - 各级 __pycache__ 目录与 .pyc 字节码    Python 缓存
 *      - .408-mentor/             学习画像（用户数据，误删不可逆）
 *      - .git/、node_modules/、Thumbs.db、.DS_Store
 *
 * 用法：
 *   node scripts/deploy.js             # 执行镜像同步
 *   node scripts/deploy.js --dry-run   # 只列出将执行的操作，不写盘
 *   node scripts/deploy.js --to <dir>  # 覆盖默认安装目录
 *
 * 退出码：0 成功；1 参数/安全检查失败。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 源目录 = 本脚本所在 scripts/ 的上一级，即开发中的 skill 根目录
const SRC = path.resolve(__dirname, '..');
// 默认目标：DSH 用户级 skill 安装目录（可用 --to 覆盖）
const DEFAULT_DEST = path.join(os.homedir(), '.dsh', 'skills', '408-mentor');

// 排除规则：相对路径前缀（目录）或后缀匹配（文件名）
const EXCLUDED_DIRS = new Set([
  'venv',
  '__pycache__',
  '.git',
  'node_modules',
  '.408-mentor',
]);
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const EXCLUDED_EXTS = new Set(['.pyc']);

function isExcluded(relPath) {
  const parts = relPath.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    if (EXCLUDED_DIRS.has(part)) return true;
  }
  const base = parts[parts.length - 1];
  if (EXCLUDED_FILES.has(base)) return true;
  if (EXCLUDED_EXTS.has(path.extname(base))) return true;
  return false;
}

/**
 * 递归收集源目录下所有待同步文件的相对路径
 */
function walkSource(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) {
      walkSource(abs, base, acc);
    } else if (entry.isFile()) {
      acc.push(rel);
    }
  }
  return acc;
}

/**
 * 递归收集目标目录下所有文件的相对路径（用于镜像删除检查）
 */
function walkTarget(dir, base = dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) {
      walkTarget(abs, base, acc);
    } else if (entry.isFile()) {
      acc.push(rel);
    }
  }
  return acc;
}

/**
 * 判断目标文件是否需要更新：不存在，或 size/mtime 与源不一致
 */
function needsCopy(srcAbs, destAbs) {
  if (!fs.existsSync(destAbs)) return true;
  const s = fs.statSync(srcAbs);
  const d = fs.statSync(destAbs);
  return s.size !== d.size || s.mtimeMs > d.mtimeMs + 500; // 500ms 容差防文件系统精度差
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const toIdx = args.indexOf('--to');
  const dest = toIdx !== -1 && args[toIdx + 1]
    ? path.resolve(args[toIdx + 1])
    : DEFAULT_DEST;

  if (!fs.existsSync(SRC)) {
    console.error(`[ERROR] 源目录不存在：${SRC}`);
    process.exit(1);
  }

  // 安全检查：目标已存在且不是 skill 形态（无 SKILL.md 且非空）→ 拒绝，防止误同步到随机目录
  if (fs.existsSync(dest)) {
    const hasSkillMd = fs.existsSync(path.join(dest, 'SKILL.md'));
    const isEmpty = fs.readdirSync(dest).length === 0;
    if (!hasSkillMd && !isEmpty) {
      console.error(`[ERROR] 目标目录既无 SKILL.md 也不为空，疑似不是 skill 安装目录：${dest}`);
      console.error('[HINT] 如确认无误，请先清空该目录或用 --to 指定其他目标');
      process.exit(1);
    }
  }

  const srcFiles = walkSource(SRC);
  const destFiles = fs.existsSync(dest) ? walkTarget(dest) : [];
  const srcSet = new Set(srcFiles);

  const toCopy = srcFiles.filter((rel) => needsCopy(path.join(SRC, rel), path.join(dest, rel)));
  const toDelete = destFiles.filter((rel) => !srcSet.has(rel));
  const skipped = srcFiles.length - toCopy.length;

  console.log(`📦 408-mentor 部署同步${dryRun ? '（dry-run 预览）' : ''}`);
  console.log(`   源：${SRC}`);
  console.log(`   目标：${dest}`);
  console.log(`   源文件 ${srcFiles.length} 个 | 待复制 ${toCopy.length} | 已最新跳过 ${skipped} | 待删除 ${toDelete.length}\n`);

  if (toDelete.length) {
    console.log('🗑️  镜像删除（目标多余文件）：');
    toDelete.forEach((rel) => console.log(`   - ${rel}`));
    console.log();
  }

  if (dryRun) {
    console.log('🔍 dry-run 结束，未写盘。去掉 --dry-run 执行同步。');
    return;
  }

  let copied = 0, deleted = 0;
  for (const rel of toCopy) {
    const srcAbs = path.join(SRC, rel);
    const destAbs = path.join(dest, rel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
    // 保持 mtime 一致，下次比对才能走"已最新跳过"快路径
    const st = fs.statSync(srcAbs);
    fs.utimesSync(destAbs, st.atime, st.mtime);
    copied++;
  }
  // 删除按路径从深到浅排序，保证先删文件再删空目录
  for (const rel of toDelete.sort((a, b) => b.length - a.length)) {
    const destAbs = path.join(dest, rel);
    try {
      fs.unlinkSync(destAbs);
      deleted++;
    } catch { /* 目录项已在更深一轮清理，忽略 */ }
  }
  // 清理删空后的残留空目录（排除清单内目录不碰）
  pruneEmptyDirs(dest, dest);

  console.log(`\n✅ 同步完成：复制 ${copied}，删除 ${deleted}。安装版 = 开发版。`);
}

/**
 * 递归删除空目录（跳过根与排除清单内的目录）
 */
function pruneEmptyDirs(dir, root) {
  if (dir === root) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      pruneEmptyDirs(path.join(dir, entry.name), root);
    }
  }
  // 子目录清理后重读，全空则删
  const remaining = fs.readdirSync(dir);
  if (remaining.length === 0 && !EXCLUDED_DIRS.has(path.basename(dir))) {
    try { fs.rmdirSync(dir); } catch { /* 非空或被占用则保留 */ }
  }
}

main();

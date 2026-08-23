#!/usr/bin/env node

/**
 * profile-manager.js
 *
 * 408-mentor 学习画像 JSON 的底层读写工具。
 * 负责格式与原子性，不负责教学决策（决策由 SKILL.md 描述，LLM 调用本脚本）。
 *
 * 数据位置：默认当前工作目录下 .408-mentor/profile.json
 * 可通过 --cwd <目录> 指定其他工作目录。
 *
 * 用法：
 *   node scripts/profile-manager.js [--cwd <目录>] read
 *   node scripts/profile-manager.js [--cwd <目录>] init --subject <ds|co|os|net> --level <beginner|review|sprint>
 *   node scripts/profile-manager.js [--cwd <目录>] update-question --chapter <章节> --topic <主题> --correct <true|false> --difficulty <easy|medium|hard>
 *   node scripts/profile-manager.js [--cwd <目录>] update-level --level <beginner|review|sprint> --reason <user_declared|phrasing_escalation|phrasing_downgrade>
 *   node scripts/profile-manager.js [--cwd <目录>] reset
 *
 * 输出：所有命令以 JSON 打印到 stdout，便于 LLM 解析。
 *      错误信息打印到 stderr，退出码非 0。
 */

const fs = require('fs');
const path = require('path');

const VALID_LEVELS = new Set(['beginner', 'review', 'sprint']);
const VALID_SUBJECTS = new Set(['ds', 'co', 'os', 'net']);
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const VALID_REASONS = new Set([
  'user_declared',
  'phrasing_escalation',
  'phrasing_downgrade',
]);

const SCHEMA_VERSION = '1';

// 弱项计算参数：最近 WINDOW 条该 topic 记录中，若答题数 >= MIN_ATTEMPTS 且正确率 < 50%，则标记为弱项
const WEAK_TOPIC_WINDOW_SIZE = 10;
const WEAK_TOPIC_MIN_ATTEMPTS = 3;
const WEAK_TOPIC_THRESHOLD = 0.5;

let PROFILE_DIR = path.join(process.cwd(), '.408-mentor');
let PROFILE_PATH = path.join(PROFILE_DIR, 'profile.json');

/**
 * 根据 cwd 解析画像路径。未指定时使用 process.cwd()。
 */
function resolveProfilePaths(cwd) {
  const base = cwd ? path.resolve(cwd) : process.cwd();
  PROFILE_DIR = path.join(base, '.408-mentor');
  PROFILE_PATH = path.join(PROFILE_DIR, 'profile.json');
}

/**
 * 从章节名推断科目。支持 "OS-内存管理"、"CO-存储系统" 等显式前缀，
 * 也支持常见章节关键词兜底。
 */
function inferSubjectFromChapter(chapter) {
  if (!chapter || typeof chapter !== 'string') return 'unknown';
  const prefix = chapter.split('-')[0].toLowerCase();
  if (VALID_SUBJECTS.has(prefix)) return prefix;

  const lower = chapter.toLowerCase();
  if (lower.includes('数据') || lower.includes('图') || lower.includes('树') || lower.includes('排序') || lower.includes('查找')) return 'ds';
  if (lower.includes('组成') || lower.includes('cache') || lower.includes('tlb') || lower.includes('流水线') || lower.includes('指令') || lower.includes('alu') || lower.includes('浮点')) return 'co';
  if (lower.includes('操作') || lower.includes('进程') || lower.includes('内存') || lower.includes('文件') || lower.includes('io') || lower.includes('pv') || lower.includes('死锁')) return 'os';
  if (lower.includes('网络') || lower.includes('tcp') || lower.includes('ip') || lower.includes('路由') || lower.includes('协议') || lower.includes('http') || lower.includes('dns')) return 'net';
  return 'unknown';
}

/**
 * 读取画像。文件不存在返回 null（不报错）。
 */
function readProfile() {
  if (!fs.existsSync(PROFILE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));
  } catch (e) {
    console.error(`[ERROR] 画像文件损坏，无法解析：${e.message}`);
    process.exit(2);
  }
}

/**
 * 创建空画像。
 */
function initProfile(subject, level) {
  if (!VALID_SUBJECTS.has(subject)) {
    console.error(`[ERROR] 无效科目：${subject}（应为 ds|co|os|net）`);
    process.exit(1);
  }
  if (!VALID_LEVELS.has(level)) {
    console.error(`[ERROR] 无效水平：${level}（应为 beginner|review|sprint）`);
    process.exit(1);
  }

  if (fs.existsSync(PROFILE_PATH)) {
    console.error(`[ERROR] 画像已存在：${PROFILE_PATH}（如需重置请先用 reset）`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const profile = {
    version: SCHEMA_VERSION,
    subject,
    createdAt: now,
    updatedAt: now,
    level,
    levelHistory: [
      { level, setAt: now, reason: 'user_declared' },
    ],
    stats: {
      totalQuestions: 0,
      correct: 0,
      wrong: 0,
      byChapter: {},
    },
    questionLog: [],
    weakTopics: [],
  };

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  writeProfile(profile);
  return profile;
}

/**
 * 原子写入画像（先写临时文件再 rename，避免崩溃损坏）。
 */
function writeProfile(profile) {
  profile.updatedAt = new Date().toISOString();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const tmpPath = PROFILE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(profile, null, 2), 'utf-8');
  fs.renameSync(tmpPath, PROFILE_PATH);
}

/**
 * 画像写锁：读-改-写不是原子的，两个 update-question 并发会互相覆盖丢记录。
 * 用独占创建的锁文件串行化变更命令；写入方崩溃留下的陈旧锁超过阈值后自动打破。
 */
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 10000;

function acquireProfileLock() {
  // 全新目录下 PROFILE_DIR 可能尚不存在（init 前创建锁文件会 ENOENT）
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const lockPath = PROFILE_PATH + '.lock';
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      // 注意：校验失败等路径会在持锁区 process.exit(1)，finally 不会执行；
      // exit 钩子是同步回调、process.exit 时仍会触发，用它兜底释放锁
      process.on('exit', () => {
        try { fs.unlinkSync(lockPath); } catch { /* 已不存在则忽略 */ }
      });
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const st = fs.statSync(lockPath);
        stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
      } catch { /* 锁刚好被释放，直接重试 */ }
      if (stale) {
        fs.unlinkSync(lockPath);
        continue;
      }
      if (Date.now() > deadline) {
        console.error(`[ERROR] 画像被并发操作锁定，等待 ${LOCK_TIMEOUT_MS}ms 超时：${lockPath}`);
        process.exit(1);
      }
      const waitUntil = Date.now() + 50;
      while (Date.now() < waitUntil) { /* 忙等重试，CLI 场景可接受 */ }
    }
  }
}

function releaseProfileLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* 已不存在则忽略 */ }
}

/**
 * 根据 questionLog 重新计算 weakTopics。
 * 规则：对每个 topic，取最近 WINDOW 条记录；若 total >= MIN_ATTEMPTS 且 correctRate < 0.5，则视为弱项。
 * 已不再是弱项的 topic 会被移除。
 */
function recalculateWeakTopics(profile) {
  const log = profile.questionLog || [];
  const byTopic = {};

  for (const entry of log) {
    const t = entry.topic;
    if (!t) continue;
    if (!byTopic[t]) byTopic[t] = [];
    byTopic[t].push(entry);
  }

  const nextWeak = [];
  const now = new Date().toISOString();

  for (const topic of Object.keys(byTopic)) {
    const recent = byTopic[topic]
      .slice(-WEAK_TOPIC_WINDOW_SIZE)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const total = recent.length;
    const correct = recent.filter((e) => e.correct).length;
    const rate = total > 0 ? correct / total : 0;

    if (total >= WEAK_TOPIC_MIN_ATTEMPTS && rate < WEAK_TOPIC_THRESHOLD) {
      const chapter = recent[recent.length - 1].chapter || 'unknown';
      const existing = (profile.weakTopics || []).find((w) => w.topic === topic);
      nextWeak.push({
        topic,
        chapter,
        subject: inferSubjectFromChapter(chapter),
        wrongCount: total - correct,
        totalCount: total,
        correctRate: Number(rate.toFixed(2)),
        firstWeakAt: existing ? existing.firstWeakAt : now,
        latestWeakAt: now,
      });
    }
  }

  // 保留顺序：按 latestWeakAt 倒序，最新的弱项在前
  profile.weakTopics = nextWeak.sort(
    (a, b) => new Date(b.latestWeakAt) - new Date(a.latestWeakAt)
  );
}

/**
 * 追加一条做题记录，并同步更新统计与弱项。
 */
function updateQuestion(chapter, topic, correct, difficulty) {
  const profile = readProfile();
  if (!profile) {
    console.error('[ERROR] 画像不存在，请先 init');
    process.exit(1);
  }
  if (!VALID_DIFFICULTIES.has(difficulty)) {
    console.error(`[ERROR] 无效难度：${difficulty}（应为 easy|medium|hard）`);
    process.exit(1);
  }
  // 严格校验：非规范值直接拒绝而不是静默记为答错（画像数据宁可拒绝不可错记）
  if (correct !== 'true' && correct !== 'false') {
    console.error(`[ERROR] 无效 correct 值：${correct}（应为 true|false，严格小写）`);
    process.exit(1);
  }

  const isCorrect = correct === 'true';
  const entry = {
    timestamp: new Date().toISOString(),
    chapter,
    topic,
    correct: isCorrect,
    difficulty,
  };

  profile.questionLog.push(entry);
  profile.stats.totalQuestions += 1;
  if (isCorrect) {
    profile.stats.correct += 1;
  } else {
    profile.stats.wrong += 1;
  }

  const ch = profile.stats.byChapter[chapter];
  if (ch) {
    ch.total += 1;
    if (isCorrect) ch.correct += 1;
  } else {
    profile.stats.byChapter[chapter] = { total: 1, correct: isCorrect ? 1 : 0 };
  }

  recalculateWeakTopics(profile);
  writeProfile(profile);
  return profile;
}

/**
 * 更新水平标签，写审计轨迹。
 */
function updateLevel(level, reason) {
  const profile = readProfile();
  if (!profile) {
    console.error('[ERROR] 画像不存在，请先 init');
    process.exit(1);
  }
  if (!VALID_LEVELS.has(level)) {
    console.error(`[ERROR] 无效水平：${level}（应为 beginner|review|sprint）`);
    process.exit(1);
  }
  if (!VALID_REASONS.has(reason)) {
    console.error(`[ERROR] 无效原因：${reason}（应为 user_declared|phrasing_escalation|phrasing_downgrade）`);
    process.exit(1);
  }

  // 同一水平不重复写轨迹
  if (profile.level !== level) {
    profile.level = level;
    profile.levelHistory.push({
      level,
      setAt: new Date().toISOString(),
      reason,
    });
    writeProfile(profile);
  }
  return profile;
}

/**
 * 重置画像（删除文件）。
 */
function resetProfile() {
  if (fs.existsSync(PROFILE_PATH)) {
    fs.unlinkSync(PROFILE_PATH);
    return { reset: true, path: PROFILE_PATH };
  }
  return { reset: false, path: PROFILE_PATH, note: '文件不存在，无需重置' };
}

/**
 * 解析 --flag value 参数对。
 * 注意：--cwd 会在 main 中提前提取，不会出现在返回结果中。
 */
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val === undefined || val.startsWith('--')) {
        console.error(`[ERROR] 参数 --${key} 缺少值`);
        process.exit(1);
      }
      flags[key] = val;
      i++;
    }
  }
  return flags;
}

/**
 * 从 argv 中提取全局 --cwd（如果存在），并返回剩余参数。
 */
function extractCwd(args) {
  const rest = [];
  let cwd = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd') {
      cwd = args[i + 1];
      i++;
    } else {
      rest.push(args[i]);
    }
  }
  return { cwd, rest };
}

function main() {
  const rawArgs = process.argv.slice(2);
  const { cwd, rest } = extractCwd(rawArgs);
  resolveProfilePaths(cwd);

  const command = rest[0];
  const flags = parseFlags(rest.slice(1));

  const runCommand = () => {
    switch (command) {
    case 'read': {
      const p = readProfile();
      console.log(JSON.stringify(p, null, 2));
      break;
    }
    case 'init': {
      if (!flags.subject || !flags.level) {
        console.error('用法：init --subject <ds|co|os|net> --level <beginner|review|sprint>');
        process.exit(1);
      }
      const p = initProfile(flags.subject, flags.level);
      console.log(JSON.stringify({ ok: true, action: 'init', path: PROFILE_PATH, profile: p }, null, 2));
      break;
    }
    case 'update-question': {
      if (!flags.chapter || !flags.topic || flags.correct === undefined || !flags.difficulty) {
        console.error('用法：update-question --chapter <章节> --topic <主题> --correct <true|false> --difficulty <easy|medium|hard>');
        process.exit(1);
      }
      const p = updateQuestion(flags.chapter, flags.topic, flags.correct, flags.difficulty);
      console.log(JSON.stringify({ ok: true, action: 'update-question', stats: p.stats, weakTopics: p.weakTopics }, null, 2));
      break;
    }
    case 'update-level': {
      if (!flags.level || !flags.reason) {
        console.error('用法：update-level --level <beginner|review|sprint> --reason <user_declared|phrasing_escalation|phrasing_downgrade>');
        process.exit(1);
      }
      const p = updateLevel(flags.level, flags.reason);
      console.log(JSON.stringify({ ok: true, action: 'update-level', level: p.level, levelHistory: p.levelHistory }, null, 2));
      break;
    }
    case 'reset': {
      const result = resetProfile();
      console.log(JSON.stringify({ ok: true, action: 'reset', ...result }, null, 2));
      break;
    }
    default:
      console.error(`未知命令：${command || '(空)'}\n`);
      console.error('用法：');
      console.error('  [--cwd <目录>] read');
      console.error('  [--cwd <目录>] init --subject <ds|co|os|net> --level <beginner|review|sprint>');
      console.error('  [--cwd <目录>] update-question --chapter <章节> --topic <主题> --correct <true|false> --difficulty <easy|medium|hard>');
      console.error('  [--cwd <目录>] update-level --level <beginner|review|sprint> --reason <user_declared|phrasing_escalation|phrasing_downgrade>');
      console.error('  [--cwd <目录>] reset');
      process.exit(1);
    }
  };

  // 变更类命令用写锁串行化，防并发读-改-写互相覆盖
  const MUTATING = new Set(['init', 'update-question', 'update-level', 'reset']);
  if (MUTATING.has(command)) {
    const lockPath = acquireProfileLock();
    try {
      runCommand();
    } finally {
      releaseProfileLock(lockPath);
    }
  } else {
    runCommand();
  }
}

main();

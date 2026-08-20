#!/usr/bin/env node

/**
 * profile-manager.js
 *
 * 408-mentor 学习画像 JSON 的底层读写工具。
 * 负责格式与原子性，不负责教学决策（决策由 SKILL.md 描述，LLM 调用本脚本）。
 *
 * 数据位置：当前工作目录下 .408-mentor/profile.json
 * 设计依据：Q5 选 C，用户可开多个工作目录天然分科隔离画像。
 *
 * 用法：
 *   node scripts/profile-manager.js read                          # 读取画像（不存在则返回 null）
 *   node scripts/profile-manager.js init --subject <ds|co|os|net> --level <beginner|review|sprint>
 *                                                                 # 初始化空画像
 *   node scripts/profile-manager.js update-question --chapter <章节> --topic <主题> --correct <true|false> --difficulty <easy|medium|hard>
 *                                                                 # 追加一条做题记录并更新统计
 *   node scripts/profile-manager.js update-level --level <beginner|review|sprint> --reason <user_declared|phrasing_escalation|phrasing_downgrade>
 *                                                                 # 更新水平标签（写审计轨迹）
 *   node scripts/profile-manager.js reset                         # 清空画像（删除文件）
 *
 * 输出：所有命令以 JSON 打印到 stdout，便于 LLM 解析。
 *      错误信息打印到 stderr，退出码非 0。
 */

const fs = require('fs');
const path = require('path');

const PROFILE_DIR = path.join(process.cwd(), '.408-mentor');
const PROFILE_PATH = path.join(PROFILE_DIR, 'profile.json');

const VALID_LEVELS = new Set(['beginner', 'review', 'sprint']);
const VALID_SUBJECTS = new Set(['ds', 'co', 'os', 'net']);
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const VALID_REASONS = new Set([
  'user_declared',
  'phrasing_escalation',
  'phrasing_downgrade',
]);

const SCHEMA_VERSION = '1';

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
 * 追加一条做题记录，并同步更新统计。
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

  const isCorrect = correct === true || correct === 'true';
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

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case 'read': {
      const p = readProfile();
      console.log(JSON.stringify(p, null, 2));
      break;
    }
    case 'init': {
      const f = parseFlags(rest);
      if (!f.subject || !f.level) {
        console.error('用法：init --subject <ds|co|os|net> --level <beginner|review|sprint>');
        process.exit(1);
      }
      const p = initProfile(f.subject, f.level);
      console.log(JSON.stringify({ ok: true, action: 'init', path: PROFILE_PATH, profile: p }, null, 2));
      break;
    }
    case 'update-question': {
      const f = parseFlags(rest);
      if (!f.chapter || !f.topic || f.correct === undefined || !f.difficulty) {
        console.error('用法：update-question --chapter <章节> --topic <主题> --correct <true|false> --difficulty <easy|medium|hard>');
        process.exit(1);
      }
      const p = updateQuestion(f.chapter, f.topic, f.correct, f.difficulty);
      console.log(JSON.stringify({ ok: true, action: 'update-question', stats: p.stats }, null, 2));
      break;
    }
    case 'update-level': {
      const f = parseFlags(rest);
      if (!f.level || !f.reason) {
        console.error('用法：update-level --level <beginner|review|sprint> --reason <user_declared|phrasing_escalation|phrasing_downgrade>');
        process.exit(1);
      }
      const p = updateLevel(f.level, f.reason);
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
      console.error('  read');
      console.error('  init --subject <ds|co|os|net> --level <beginner|review|sprint>');
      console.error('  update-question --chapter <章节> --topic <主题> --correct <true|false> --difficulty <easy|medium|hard>');
      console.error('  update-level --level <beginner|review|sprint> --reason <user_declared|phrasing_escalation|phrasing_downgrade>');
      console.error('  reset');
      process.exit(1);
  }
}

main();
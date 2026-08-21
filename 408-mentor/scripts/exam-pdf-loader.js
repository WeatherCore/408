#!/usr/bin/env node

/**
 * exam-pdf-loader.js
 *
 * 真题 PDF 批量索引构建工具。
 * 从 data/exams/ 和 data/answers/ 的 PDF 中提取文本，按题号分割，
 * 生成倒排索引（知识点→年份+题号）存入 references/exam-archive/exam-index.json。
 *
 * 索引是一次性资产，建好后 LLM 运行时只读不建。
 *
 * 用法：
 *   node scripts/exam-pdf-loader.js extract-all          # 批处理所有年份的 PDF 文本
 *   node scripts/exam-pdf-loader.js split <年份>          # 按题号分割指定年份的文本
 *   node scripts/exam-pdf-loader.js list                  # 列出所有已提取的年份
 *   node scripts/exam-pdf-loader.js stats                 # 查看题库统计
 *   node scripts/exam-pdf-loader.js search <关键词>       # 搜索索引中的题目
 *   node scripts/exam-pdf-loader.js --help                # 显示帮助
 *
 * 设计说明：
 * - 纯文本提取和分割由此脚本完成（确定性操作）
 * - 知识点标注（LLM 逐题分析）不在脚本中，由 408-mentor 的 LLM 上下文完成
 * - 标注完成后，结果写入 exam-index.json，后续检索时 LLM 直接 Read 该文件
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXAMS_DIR = path.join(ROOT, 'data', 'exams');
const ANSWERS_DIR = path.join(ROOT, 'data', 'answers');
const ARCHIVE_DIR = path.join(ROOT, 'references', 'exam-archive');
const TEXT_DIR = path.join(ARCHIVE_DIR, 'extracted-text');
const INDEX_PATH = path.join(ARCHIVE_DIR, 'exam-index.json');

// PDF-Craft Python 路径（需先运行 scripts/pdfcraft/setup.bat 初始化环境）
function getPdfcraftPython() {
  // Windows: venv/Scripts/python.exe
  const venvPython = path.join(ROOT, 'scripts', 'pdfcraft', 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  // Fallback: system python
  return 'python';
}

function getPdfcraftPath() {
  return path.join(ROOT, 'scripts', 'pdfcraft', 'pdfcraft.py');
}

/**
 * 确保目录存在
 */
function ensureDirs() {
  [ARCHIVE_DIR, TEXT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

/**
 * 获取所有年份的 PDF 文件列表
 */
function listExamPDFs() {
  const years = [];
  for (const subdir of ['2010-2019', '2020-2025']) {
    const dir = path.join(EXAMS_DIR, subdir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      const match = file.match(/^(\d{4})\.pdf$/);
      if (match) {
        years.push({
          year: parseInt(match[1], 10),
          examPath: path.join(dir, file),
          answerPath: path.join(ANSWERS_DIR, subdir, `${match[1]}-answer.pdf`),
        });
      }
    }
  }
  return years.sort((a, b) => a.year - b.year);
}

/**
 * 用 PDF-Craft 提取单个 PDF 的纯文本
 */
function extractText(pdfPath, year, type) {
  const outputPath = path.join(TEXT_DIR, `${year}-${type}.txt`);
  const python = getPdfcraftPython();
  const script = getPdfcraftPath();

  if (!fs.existsSync(script)) {
    console.error(`[ERROR] PDF-Craft 未找到：${script}`);
    console.error('[HINT] 运行 scripts/pdfcraft/setup.bat 初始化环境');
    return null;
  }

  if (fs.existsSync(outputPath)) {
    console.log(`[SKIP] ${year}-${type} 已提取，跳过`);
    return outputPath;
  }

  console.log(`[EXTRACT] ${year}-${type}：${pdfPath}`);
  try {
    const result = execSync(
      `"${python}" "${script}" extract_text --input "${pdfPath}"`,
      { encoding: 'utf-8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
    );

    // extract_text 返回 JSON {"ok": true, "data": {"pages": [...]}}
    const parsed = JSON.parse(result);
    if (!parsed.ok) {
      console.error(`[ERROR] ${year}-${type} 提取失败：${parsed.error}`);
      return null;
    }

    // 拼接所有页面的文本
    const pages = parsed.data?.pages || [];
    let text = '';
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (page && page.text) {
        text += `\n=== 第 ${i + 1} 页 ===\n${page.text}`;
      }
    }

    fs.writeFileSync(outputPath, text, 'utf-8');
    console.log(`[OK] ${year}-${type} 提取完成（${text.length} 字符）`);
    return outputPath;
  } catch (e) {
    console.error(`[ERROR] ${year}-${type} 提取失败：${e.message}`);
    return null;
  }
}

/**
 * 批处理所有年份的 PDF 文本提取
 */
function extractAll() {
  ensureDirs();
  const pdfs = listExamPDFs();
  console.log(`\n📚 开始批处理 ${pdfs.length} 年真题 + 答案 PDF...\n`);

  let success = 0;
  let fail = 0;

  for (const { year, examPath, answerPath } of pdfs) {
    if (fs.existsSync(examPath)) {
      const result = extractText(examPath, year, 'exam');
      result ? success++ : fail++;
    }
    if (fs.existsSync(answerPath)) {
      const result = extractText(answerPath, year, 'answer');
      result ? success++ : fail++;
    }
  }

  console.log(`\n✅ 完成：${success} 成功，${fail} 失败`);
  console.log(`📁 文本输出目录：${TEXT_DIR}`);
}

/**
 * 按题号分割指定年份的真题文本
 *
 * 408 真题固定格式：
 *   一、单项选择题：1~40 小题，每小题 2 分，共 80 分
 *   二、综合应用题：41~47 小题，共 70 分
 */
function splitByYear(year) {
  const examPath = path.join(TEXT_DIR, `${year}-exam.txt`);
  if (!fs.existsSync(examPath)) {
    console.error(`[ERROR] 未找到 ${year} 年的提取文本，请先运行 extract-all`);
    return null;
  }

  const text = fs.readFileSync(examPath, 'utf-8');
  const questions = [];

  // 尝试分割选择题（1-40）
  // 408 真题格式：数字 + 点 + 空格 + 题目内容
  const choicePattern = /\n(\d{1,2})[.、]\s+([\s\S]*?)(?=\n\d{1,2}[.、]\s+|\n二[、.]|\n三[、.]|$)/g;
  let match;
  while ((match = choicePattern.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 40) {
      questions.push({
        year,
        number: num,
        type: 'choice',
        rawText: match[2].trim().substring(0, 500),
        examPage: null, // 页码需要从提取文本中推断
      });
    }
  }

  // 尝试分割综合题（41-47）
  const compPattern = /\n(4[1-7])[.、]\s+([\s\S]*?)(?=\n4[1-7][.、]\s+|$)/g;
  while ((match = compPattern.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    questions.push({
      year,
      number: num,
      type: 'comprehensive',
      rawText: match[2].trim().substring(0, 800),
      examPage: null,
    });
  }

  // 输出分割结果
  const outputPath = path.join(ARCHIVE_DIR, `split-${year}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(questions, null, 2), 'utf-8');

  console.log(`\n📋 ${year} 年分割结果：`);
  console.log(`   选择题：${questions.filter(q => q.type === 'choice').length} 题`);
  console.log(`   综合题：${questions.filter(q => q.type === 'comprehensive').length} 题`);
  console.log(`   总计：  ${questions.length} 题`);
  console.log(`   输出：  ${outputPath}`);

  return questions;
}

/**
 * 列出所有已提取的年份
 */
function listExtracted() {
  ensureDirs();
  const files = fs.readdirSync(TEXT_DIR).filter(f => f.endsWith('.txt'));
  if (files.length === 0) {
    console.log('📭 尚未提取任何文本。运行 extract-all 开始。');
    return;
  }
  console.log('\n📚 已提取的文本：');
  files.sort().forEach(f => console.log(`   ${f}`));
}

/**
 * 查看题库统计
 */
function showStats() {
  ensureDirs();

  if (!fs.existsSync(INDEX_PATH)) {
    console.log('📭 索引尚未建立。');
    console.log('   流程：1) extract-all → 2) split → 3) LLM 标注 → 4) 写入 exam-index.json');
    return;
  }

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  const total = index.questions?.length || 0;
  const bySubject = {};
  const byYear = {};
  const byType = {};

  for (const q of index.questions || []) {
    bySubject[q.subject] = (bySubject[q.subject] || 0) + 1;
    byYear[q.year] = (byYear[q.year] || 0) + 1;
    byType[q.type] = (byType[q.type] || 0) + 1;
  }

  console.log(`\n📊 真题索引统计：`);
  console.log(`   总题目数：${total}`);
  console.log(`\n   按科目：`);
  for (const [s, c] of Object.entries(bySubject)) console.log(`     ${s}: ${c} 题`);
  console.log(`\n   按题型：`);
  for (const [t, c] of Object.entries(byType)) console.log(`     ${t}: ${c} 题`);
  console.log(`\n   按年份：`);
  for (const [y, c] of Object.entries(byYear).sort()) console.log(`     ${y}: ${c} 题`);
}

/**
 * 搜索索引中的题目
 */
function searchIndex(keyword) {
  if (!fs.existsSync(INDEX_PATH)) {
    console.log('📭 索引尚未建立，无法搜索。');
    return;
  }

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  const questions = index.questions || [];
  const kw = keyword.toLowerCase();

  const matches = questions.filter(q => {
    const text = `${q.topics?.join(' ') || ''} ${q.rawText || ''}`.toLowerCase();
    return text.includes(kw);
  });

  console.log(`\n🔍 搜索 "${keyword}"：${matches.length} 条结果\n`);
  matches.slice(0, 10).forEach(q => {
    console.log(`[${q.year}] 第${q.number}题 | ${q.subject} | ${q.type} | ${q.topics?.join(', ') || '?'}`);
    console.log(`   ${q.rawText?.substring(0, 120)}...`);
    console.log();
  });
}

function showHelp() {
  console.log(`\n📚 408-mentor 真题 PDF 索引构建工具`);
  console.log(`======================================`);
  console.log(`\n用法：`);
  console.log(`  extract-all           批处理所有年份 PDF 文本提取`);
  console.log(`  split <年份>          按题号分割指定年份的真题（如 split 2024）`);
  console.log(`  list                  列出所有已提取的年份`);
  console.log(`  stats                 查看题库统计`);
  console.log(`  search <关键词>       搜索索引中的题目`);
  console.log(`  --help                显示帮助`);
  console.log(`\n索引构建流程：`);
  console.log(`  1. extract-all  → 提取 34 个 PDF 的纯文本`);
  console.log(`  2. split <年份>  → 逐题分割为结构化 JSON`);
  console.log(`  3. LLM 标注     → 逐题分析知识点（由 408-mentor 的 LLM 完成）`);
  console.log(`  4. 写入索引     → 生成 exam-index.json（倒排索引）`);
  console.log(`\n前置条件：`);
  console.log(`  运行 scripts/pdfcraft/setup.bat 初始化 Python 环境`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'extract-all':
      extractAll();
      break;
    case 'split':
      if (!args[1]) {
        console.error('用法：split <年份>（如 split 2024）');
        process.exit(1);
      }
      splitByYear(parseInt(args[1], 10));
      break;
    case 'list':
      listExtracted();
      break;
    case 'stats':
      showStats();
      break;
    case 'search':
      if (!args[1]) {
        console.error('用法：search <关键词>');
        process.exit(1);
      }
      searchIndex(args[1]);
      break;
    case '--help':
    case 'help':
      showHelp();
      break;
    default:
      showHelp();
      break;
  }
}

main();
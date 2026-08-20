#!/usr/bin/env node

/**
 * exam-pdf-loader.js
 *
 * 真题 PDF 解析/缓存工具（预留）。
 * 当用户提供历年真题 PDF 后，此脚本负责：
 *   1. 从 PDF 中提取文本内容（题目+答案+解析）
 *   2. 按科目、年份、题型分类
 *   3. 构建可检索的 JSON 索引
 *   4. 缓存到 references/exam-archive/ 目录
 *
 * 当前状态：🚧 预留 — 等待用户提供真题 PDF 后激活
 *
 * 用法（未来）：
 *   node scripts/exam-pdf-loader.js --import ./历年真题/2024.pdf --year 2024
 *   node scripts/exam-pdf-loader.js --search "缺页中断" --limit 5
 *   node scripts/exam-pdf-loader.js --stats          # 查看题库统计
 *
 * 前置依赖（安装后方可使用完整功能）：
 *   npm install pdf-parse  （PDF 文本提取）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join(ROOT, 'references', 'exam-archive');
const INDEX_PATH = path.join(ARCHIVE_DIR, 'exam-index.json');

/**
 * 确保存档目录存在
 */
function ensureArchiveDir() {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

/**
 * 获取当前题库统计信息
 */
function getStats() {
  ensureArchiveDir();

  if (!fs.existsSync(INDEX_PATH)) {
    console.log('📭 题库为空。请先导入真题 PDF。');
    console.log(`\n用法（PDF 文件就位后）：`);
    console.log(`  node scripts/exam-pdf-loader.js --import <pdf文件路径> --year <年份>`);
    return;
  }

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  const { exams, questions, lastUpdated } = index;

  console.log(`\n📊 题库统计：`);
  console.log(`   已导入试卷数：${exams?.length || 0}`);
  console.log(`   总题目数：    ${questions?.length || 0}`);
  console.log(`   最后更新：    ${lastUpdated || '未知'}`);

  // 按科目统计
  if (questions && questions.length > 0) {
    const bySubject = {};
    for (const q of questions) {
      const subj = q.subject || '未分类';
      bySubject[subj] = (bySubject[subj] || 0) + 1;
    }
    console.log(`\n   按科目分布：`);
    for (const [subj, count] of Object.entries(bySubject)) {
      console.log(`     ${subj}: ${count} 题`);
    }

    // 按题型统计
    const byType = {};
    for (const q of questions) {
      const type = q.type || '未知';
      byType[type] = (byType[type] || 0) + 1;
    }
    console.log(`\n   按题型分布：`);
    for (const [type, count] of Object.entries(byType)) {
      console.log(`     ${type}: ${count} 题`);
    }
  }
}

/**
 * 搜索题目（占位 — 等待 PDF 解析功能就绪）
 */
function searchQuestions(keyword, limit = 5) {
  ensureArchiveDir();

  if (!fs.existsSync(INDEX_PATH)) {
    console.log('📭 题库为空，无法搜索。');
    return;
  }

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  const questions = index.questions || [];

  const kw = keyword.toLowerCase();
  const matches = questions.filter(q => {
    const text = `${q.question || ''} ${q.options ? q.options.join(' ') : ''} ${q.answer || ''}`;
    return text.toLowerCase().includes(kw);
  });

  console.log(`\n🔍 搜索关键词："${keyword}"，找到 ${matches.length} 条结果：\n`);

  const show = matches.slice(0, limit);
  for (const q of show) {
    console.log(`[${q.year || '??'}] ${q.subject || '?'} | ${q.type || '?'}`);
    console.log(`   ${q.question?.substring(0, 120)}${q.question?.length > 120 ? '…' : ''}`);
    if (q.options) {
      q.options.forEach((opt, i) => console.log(`   ${String.fromCharCode(65 + i)}) ${opt.substring(0, 80)}`));
    }
    console.log(`   答案：${q.answer || '?'}`);
    console.log();
  }

  if (matches.length > limit) {
    console.log(`... 还有 ${matches.length - limit} 条结果未显示（使用 --limit N 查看更多）`);
  }
}

/**
 * 导入 PDF（占位 — 等待用户提供 PDF 后实现）
 */
function importExam(pdfPath, year) {
  console.log(`\n🚧 功能开发中 — 等待 PDF 解析库准备就绪。`);
  console.log(`   目标文件：${pdfPath}`);
  console.log(`   年份：    ${year}`);
  console.log(`\n计划实现流程：`);
  console.log(`   1. 用 pdf-parse 提取原始文本`);
  console.log(`   2. NLP 分割题目（按题号/题型分段）`);
  console.log(`   3. 提取选项、答案、解析`);
  console.log(`   4. 根据关键词表自动分类到科目`);
  console.log(`   5. 追加到 exam-index.json`);
  console.log(`   6. 更新统计信息`);
  console.log(`\n前置条件：`);
  console.log(`   npm install pdf-parse`);
  console.log(`   将真题 PDF 放入指定目录`);
}

/**
 * 主入口
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`\n📚 408-mentor 真题 PDF 加载工具`);
    console.log(`================================`);
    console.log(`\n用法：`);
    console.log(`  --stats                 查看题库统计`);
    console.log(`  --search <关键词>       搜索题目`);
    console.log(`  --import <路径> --year <年份>  导入真题 PDF（预留）`);
    console.log(`  --help                  显示帮助\n`);
    return;
  }

  if (args.includes('--stats')) {
    getStats();
    return;
  }

  if (args.includes('--search')) {
    const idx = args.indexOf('--search');
    const keyword = args[idx + 1];
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 5;
    if (!keyword) {
      console.error('请提供搜索关键词：--search \"关键词\"');
      process.exit(1);
    }
    searchQuestions(keyword, limit);
    return;
  }

  if (args.includes('--import')) {
    const idx = args.indexOf('--import');
    const pdfPath = args[idx + 1];
    const yearIdx = args.indexOf('--year');
    const year = yearIdx >= 0 ? args[yearIdx + 1] : '未知';
    if (!pdfPath) {
      console.error('请提供 PDF 文件路径');
      process.exit(1);
    }
    importExam(pdfPath, year);
    return;
  }

  if (args.includes('--help')) {
    console.log(`\n📚 408-mentor 真题 PDF 加载工具`);
    console.log(`================================`);
    console.log(`\n用法：`);
    console.log(`  --stats                 查看题库统计`);
    console.log(`  --search <关键词>       搜索题目`);
    console.log(`  --import <路径> --year <年份>  导入真题 PDF（预留）`);
    console.log(`  --help                  显示帮助\n`);
    return;
  }

  console.log('未知参数。使用 --help 查看帮助。');
}

main();
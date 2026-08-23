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
 *   node scripts/exam-pdf-loader.js backfill              # 将 split 产物的 examPage/rawText 回填进索引
 *   node scripts/exam-pdf-loader.js list                  # 列出所有已提取的年份
 *   node scripts/exam-pdf-loader.js stats                 # 查看题库统计
 *   node scripts/exam-pdf-loader.js search <关键词>...     # 搜索索引中的题目（多关键词为 AND）
 *   node scripts/exam-pdf-loader.js --help                # 显示帮助
 *
 * 设计说明：
 * - 纯文本提取和分割由此脚本完成（确定性操作）
 * - 知识点标注（LLM 逐题分析）不在脚本中，由 408-mentor 的 LLM 上下文完成
 * - 标注完成后，结果写入 exam-index.json，后续检索一律通过 search 子命令，
 *   不要直接 Read 该文件（约 400KB，会撑爆上下文）
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
    // 只把"有实质内容"的产物视为已完成；近空文件（如旧版本对扫描件写出的 0 字节 txt）重新提取
    const existing = fs.readFileSync(outputPath, 'utf-8');
    if (existing.trim().length >= 50) {
      console.log(`[SKIP] ${year}-${type} 已提取，跳过`);
      return outputPath;
    }
    console.log(`[WARN] ${year}-${type} 已有文件近乎为空，重新提取`);
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

    // 0 字符几乎必是扫描版 PDF（无文本层）：记为失败且不写文件（写了会永久挡住重提取）
    if (text.trim().length === 0) {
      console.error(`[ERROR] ${year}-${type} 提取到 0 字符（PDF 可能为扫描件、无文本层）`);
      console.error('[HINT] 扫描版 PDF 请走 OCR 路径：python scripts/extract_exam_text.py <pdf路径>');
      return null;
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

  // 先按页分割文本，记录每个段落在哪一页
  const pageSegments = [];
  const pageSplitPattern = /=== 第 (\d+) 页 ===/g;
  let currentPage = 1;
  let lastIndex = 0;
  let pageMatch;

  // 找到所有页面标记
  const pageMarks = [];
  while ((pageMatch = pageSplitPattern.exec(text)) !== null) {
    pageMarks.push({ index: pageMatch.index, page: parseInt(pageMatch[1], 10) });
  }

  // 为每个文本段分配页码
  function getCurrentPageFromIndex(textIndex) {
    let currentPage = 1;
    for (const mark of pageMarks) {
      if (textIndex > mark.index) {
        currentPage = mark.page;
      } else {
        break;
      }
    }
    return currentPage;
  }

  // 尝试分割选择题（1-40）
  // 408 真题格式：数字 + 点 + 题目内容（点后空格可有可无：2009-2011 有空格，2012+ 双位数题号无空格）
  // \s* 而非 \s+：兼容 "10.在内部排序" 这种无空格排版
  const choicePattern = /\n(\d{1,2})[.、]\s*([\s\S]*?)(?=\n\d{1,2}[.、]\s*|\n二[、.]|\n三[、.]|$)/g;
  let match;
  while ((match = choicePattern.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 40) {
      questions.push({
        year,
        number: num,
        type: 'choice',
        rawText: match[2].trim().substring(0, 500),
        examPage: getCurrentPageFromIndex(match.index),
      });
    }
  }

  // 尝试分割综合题（41-47）
  // 同 choicePattern：\s* 兼容 "41.（10 分）" 这种点号后直接接全角括号无空格的排版
  const compPattern = /\n(4[1-7])[.、]\s*([\s\S]*?)(?=\n4[1-7][.、]\s*|$)/g;
  while ((match = compPattern.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    questions.push({
      year,
      number: num,
      type: 'comprehensive',
      rawText: match[2].trim().substring(0, 800),
      examPage: getCurrentPageFromIndex(match.index),
    });
  }

  // 去重：\s* 放宽后，正文里行首"数字+点号"（如计算题的 10.某值、二进制 10.xxxx、综合题表格数据）会被误当题号重复匹配。
  // 408 题号 1-47 严格唯一，按题号保留**首次出现**：
  //   实测 17 年真题文本中，噪声匹配（路由表/小节编号等）总是出现在真题号**之后**，
  //   且其吞并的长正文反而更长——"保留最长"会误选噪声（2014/2018/2022/2024 实证），故维持保留首次。
  // 有重复匹配时逐号 warn 提示人工核验；去重后题数 ≠ 47 也会 warn。
  const seen = new Set();
  const dupNumbers = new Set();
  const deduped = questions.filter(q => {
    if (seen.has(q.number)) { dupNumbers.add(q.number); return false; }
    seen.add(q.number);
    return true;
  });
  if (dupNumbers.size > 0) {
    console.warn(`[WARN] ${year} 年以下题号匹配到多次（已保留首次出现，请核验对应题内容无误切）：${[...dupNumbers].sort((a, b) => a - b).join(', ')}`);
  }

  // 输出分割结果
  const outputPath = path.join(ARCHIVE_DIR, `split-${year}.json`);

  // 断言：408 每年应有 47 题（40 选择 + 7 综合），切漏或仍有误切时 warn
  if (deduped.length < 40) {
    console.warn(`[WARN] ${year} 年去重后只切出 ${deduped.length} 题（应有 47），可能切漏，请检查 extracted-text/${year}-exam.txt`);
  } else if (deduped.length > 47) {
    console.warn(`[WARN] ${year} 年去重后切出 ${deduped.length} 题（应为 47），仍有重复或超范围误切，请检查 extracted-text/${year}-exam.txt`);
  }

  fs.writeFileSync(outputPath, JSON.stringify(deduped, null, 2), 'utf-8');

  console.log(`\n📋 ${year} 年分割结果：`);
  console.log(`   选择题：${deduped.filter(q => q.type === 'choice').length} 题`);
  console.log(`   综合题：${deduped.filter(q => q.type === 'comprehensive').length} 题`);
  console.log(`   总计：  ${deduped.length} 题`);
  console.log(`   输出：  ${outputPath}`);

  return deduped;
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
 * 将 split-<年份>.json 中的 examPage/rawText 回填到 exam-index.json
 *
 * 索引由「split 产物 + LLM 标注」合成，标注环节可能丢失字段或整题
 * （2026-08 审计：791 题全部丢 rawText、431 题丢 examPage、2015 年 #40-47 漏标）。
 * split 产物是数据源头（页码 100% 有值），本命令以 split 为准做幂等回填：
 * 索引已有的题合并缺失字段；split 有而索引没有的题以最小字段补入（topics 留空待标注）。
 */
function backfill() {
  if (!fs.existsSync(INDEX_PATH)) {
    console.log('📭 索引尚未建立，无法回填。');
    return;
  }
  const splitFiles = fs.readdirSync(ARCHIVE_DIR).filter(f => /^split-\d{4}\.json$/.test(f)).sort();
  if (splitFiles.length === 0) {
    console.log('📭 未找到 split-<年份>.json，请先运行 split <年份>。');
    return;
  }

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  const byKey = new Map((index.questions || []).map(q => [`${q.year}-${q.number}`, q]));

  let merged = 0;
  let added = 0;
  for (const f of splitFiles) {
    const splits = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf-8'));
    for (const s of splits) {
      const key = `${s.year}-${s.number}`;
      const q = byKey.get(key);
      if (q) {
        if (s.examPage && !q.examPage) q.examPage = s.examPage;
        if (s.rawText && !q.rawText) q.rawText = s.rawText;
        merged++;
      } else {
        byKey.set(key, {
          year: s.year,
          number: s.number,
          type: s.type,
          subject: null,
          chapter: null,
          topics: [],
          difficulty: null,
          examPage: s.examPage || 0,
          answerPage: 0,
          rawText: s.rawText || '',
        });
        added++;
      }
    }
  }

  index.questions = Array.from(byKey.values()).sort((a, b) => a.year - b.year || a.number - b.number);
  index.totalQuestions = index.questions.length;
  index.lastUpdated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');

  const noPage = index.questions.filter(q => !q.examPage).length;
  const noTopics = index.questions.filter(q => !q.topics || q.topics.length === 0).length;
  console.log(`\n🔁 回填完成：合并 ${merged} 题，新增 ${added} 题，索引共 ${index.questions.length} 题`);
  console.log(`   examPage 缺失：${noPage} 题${noPage ? '（请检查对应 split 文件）' : ''}`);
  console.log(`   topics 未标注：${noTopics} 题${noTopics ? '（需 LLM 补标注）' : ''}`);
}

/**
 * 搜索索引中的题目
 *
 * 多关键词为 AND 语义（topics + rawText 需同时包含全部关键词），
 * 供跨科综合题检索（如 search 虚拟内存 TLB）。
 * 结果按年份倒序，与「优先近 6 年真题」的出题策略一致。
 */
function searchIndex(keywords) {
  if (!fs.existsSync(INDEX_PATH)) {
    console.log('📭 索引尚未建立，无法搜索。');
    return;
  }

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  const questions = index.questions || [];
  const kws = keywords.map(k => k.toLowerCase());

  const matches = questions.filter(q => {
    const text = `${q.topics?.join(' ') || ''} ${q.rawText || ''}`.toLowerCase();
    return kws.every(kw => text.includes(kw));
  });
  matches.sort((a, b) => b.year - a.year || a.number - b.number);

  console.log(`\n🔍 搜索 ${keywords.map(k => `"${k}"`).join(' + ')}：${matches.length} 条结果\n`);
  matches.slice(0, 10).forEach(q => {
    const page = q.examPage ? `第${q.examPage}页` : '页码未知';
    console.log(`[${q.year}] 第${q.number}题 | ${q.type} | ${page} | ${q.subject || '?'} | ${q.topics?.join(', ') || '未标注'}`);
    if (q.rawText) {
      console.log(`   ${q.rawText.substring(0, 100).replace(/\n/g, ' ')}…`);
    }
    console.log();
  });
  if (matches.length > 10) {
    console.log(`   …仅显示前 10 条，共 ${matches.length} 条`);
  }
}

function showHelp() {
  console.log(`\n📚 408-mentor 真题 PDF 索引构建工具`);
  console.log(`======================================`);
  console.log(`\n用法：`);
  console.log(`  extract-all           批处理所有年份 PDF 文本提取`);
  console.log(`  split <年份>          按题号分割指定年份的真题（如 split 2024）`);
  console.log(`  backfill              将 split 产物的 examPage/rawText 回填进索引`);
  console.log(`  list                  列出所有已提取的年份`);
  console.log(`  stats                 查看题库统计`);
  console.log(`  search <关键词>...     搜索索引中的题目（多关键词为 AND）`);
  console.log(`  --help                显示帮助`);
console.log(`\n索引构建流程：`);
  console.log(`  1. extract-all  → 提取 34 个 PDF 的纯文本`);
  console.log(`  2. split <年份>  → 逐题分割为结构化 JSON`);
  console.log(`  3. LLM 标注     → 逐题分析知识点（由 408-mentor 的 LLM 完成）`);
  console.log(`  4. backfill     → 将 split 的 examPage/rawText 回填进索引（防标注丢字段）`);
  console.log(`  5. 写入索引     → 生成 exam-index.json（倒排索引）`);
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
    case 'backfill':
      backfill();
      break;
    case 'search':
      if (!args[1]) {
        console.error('用法：search <关键词> [关键词2 ...]（多关键词为 AND）');
        process.exit(1);
      }
      searchIndex(args.slice(1));
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
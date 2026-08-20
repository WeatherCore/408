#!/usr/bin/env node

/**
 * build-keyword-index.js
 *
 * 从 408-syllabus-outline.md 中提取术语，构建/更新 keyword-index。
 * 
 * 用法：
 *   node scripts/build-keyword-index.js                    # 从大纲重建索引
 *   node scripts/build-keyword-index.js --check            # 检查 keyword-index 完整性
 *   node scripts/build-keyword-index.js --add "术语|科目|章节"  # 手动添加术语
 *
 * 设计说明：
 * - 读取 references/408-syllabus-outline.md，解析标题+条目
 * - 输出格式兼容 references/408-keyword-index.md 的表格语法
 * - 生成结果可手动合并到 keyword-index 中，或直接覆盖
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SYLLABUS_PATH = path.join(ROOT, 'references', '408-syllabus-outline.md');
const KEYWORD_PATH = path.join(ROOT, 'references', '408-keyword-index.md');

// 科目代码映射
const SUBJECT_MAP = {
  '数据结构': 'DS',
  '计算机组成原理': 'CO',
  '操作系统': 'OS',
  '计算机网络': 'NET',
};

// 科目章节编号映射（用于从大纲标题推断章节编号）
const CHAPTER_PREFIX = {
  'DS': ['线性表', '栈', '树', '图', '查找', '排序'],
  'CO': ['系统概述', '数据表示', '存储系统', '指令系统', 'CPU', '总线', 'I/O'],
  'OS': ['OS概述', '进程管理', '内存管理', '文件管理', 'IO管理'],
  'NET': ['体系结构', '物理层', '数据链路层', '网络层', '传输层', '应用层'],
};

/**
 * 从大纲文件中提取所有术语条目
 */
function extractTermsFromSyllabus(markdown) {
  const lines = markdown.split('\n');
  const terms = [];
  let currentSubject = null;
  let currentChapter = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测科目标题（## 一、数据结构 等）
    const subjectMatch = line.match(/^##\s+(?:一|二|三|四)[、.](.+)$/);
    if (subjectMatch) {
      const name = subjectMatch[1].trim();
      currentSubject = SUBJECT_MAP[name] || null;
      currentChapter = null;
      continue;
    }

    // 检测章节标题（### N. 章节名）
    const chapterMatch = line.match(/^###\s+\d+[.、\s]+(.+)$/);
    if (chapterMatch && currentSubject) {
      currentChapter = `${currentSubject}-${chapterMatch[1].trim()}`;
      continue;
    }

    // 提取术语（**术语** 或 - 术语（说明） 格式）
    if (currentSubject && currentChapter) {
      // 匹配 **术语** 或 **术语/术语**
      const boldMatch = line.match(/\*\*([^*]+)\*\*/);
      if (boldMatch) {
        const term = boldMatch[1].trim();
        // 拆分 / 分隔的术语（如 "并发/并行"）
        const subTerms = term.split('/').map(t => t.trim());
        for (const t of subTerms) {
          if (t.length > 0 && t.length < 30) {
            terms.push({ term: t, subject: currentSubject, chapter: currentChapter });
          }
        }
      }

      // 匹配括号中的英文缩写（如 "TLB（Translation Lookaside Buffer，页表缓存）"）
      const abbrMatch = line.match(/^[-*]\s*\*\*?([^*]+?)\*\*?\s*（(.+?)）/);
      if (abbrMatch) {
        const cnTerm = abbrMatch[1].trim();
        if (cnTerm.length > 0 && cnTerm.length < 30) {
          terms.push({ term: cnTerm, subject: currentSubject, chapter: currentChapter });
        }
        // 也提取括号内的英文术语
        const enContent = abbrMatch[2];
        const enMatch = enContent.match(/^([A-Za-z/]+)/);
        if (enMatch) {
          const enTerms = enMatch[1].split('/').map(t => t.trim());
          for (const t of enTerms) {
            if (t.length > 0 && t.length < 30) {
              terms.push({ term: t, subject: currentSubject, chapter: currentChapter });
            }
          }
        }
      }
    }
  }

  return terms;
}

/**
 * 去重并格式化
 */
function formatIndex(terms) {
  // 去重（同一科目章节下同一术语只保留一次）
  const seen = new Set();
  const unique = [];
  for (const t of terms) {
    const key = `${t.term}|${t.subject}|${t.chapter}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(t);
    }
  }

  // 按科目分组
  const grouped = {};
  for (const t of unique) {
    if (!grouped[t.subject]) grouped[t.subject] = [];
    grouped[t.subject].push(t);
  }

  let output = `# 408 术语→科目→章节映射索引（自动生成）\n\n`;
  output += `> 由 build-keyword-index.js 从考纲大纲自动提取。\n`;
  output += `> 格式：\`术语 | 科目 | 章节\`\n\n`;

  for (const [subject, items] of Object.entries(grouped)) {
    output += `---\n\n## ${Object.keys(SUBJECT_MAP).find(k => SUBJECT_MAP[k] === subject) || subject}\n\n`;
    output += `| 术语 | 章节 |\n|------|------|\n`;
    for (const t of items) {
      output += `| ${t.term} | ${t.chapter} |\n`;
    }
    output += '\n';
  }

  return output;
}

/**
 * 检查 keyword-index 的覆盖率
 */
function checkCoverage() {
  if (!fs.existsSync(SYLLABUS_PATH)) {
    console.error('[ERROR] 大纲文件不存在：', SYLLABUS_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(KEYWORD_PATH)) {
    console.error('[ERROR] 关键词索引文件不存在：', KEYWORD_PATH);
    process.exit(1);
  }

  const syllabusMd = fs.readFileSync(SYLLABUS_PATH, 'utf-8');
  const keywordMd = fs.readFileSync(KEYWORD_PATH, 'utf-8');

  const extracted = extractTermsFromSyllabus(syllabusMd);
  const extractedSet = new Set(extracted.map(t => t.term));

  // 提取 keyword-index 中已有的术语
  const existingTerms = new Set();
  for (const line of keywordMd.split('\n')) {
    const match = line.match(/^\|\s*([^|]+?)\s*\|/);
    if (match && !line.includes('术语') && !line.includes('---')) {
      const term = match[1].trim();
      if (term.length > 0 && term.length < 30) {
        existingTerms.add(term);
      }
    }
  }

  // 找出大纲中有但索引中缺失的术语
  const missing = [...extractedSet].filter(t => !existingTerms.has(t));
  // 找出索引中有但大纲中可能没有的术语
  const extra = [...existingTerms].filter(t => !extractedSet.has(t) && t.length > 1);

  console.log(`\n📊 覆盖率检查报告：`);
  console.log(`   大纲可提取术语数：${extractedSet.size}`);
  console.log(`   索引已有术语数：  ${existingTerms.size}`);
  console.log(`   缺失术语：        ${missing.length}`);
  console.log(`   额外术语：        ${extra.length}（手动添加的术语）\n`);

  if (missing.length > 0) {
    console.log('⚠️  以下术语在大纲中但不在索引中：');
    missing.forEach(t => console.log(`   - ${t}`));
    console.log();
  }

  if (extra.length > 0) {
    console.log('ℹ️  以下术语在索引中但不在自动提取范围内（可能是手动添加的跨科/扩展术语）：');
    extra.slice(0, 20).forEach(t => console.log(`   - ${t}`));
    if (extra.length > 20) console.log(`   ... 还有 ${extra.length - 20} 个`);
    console.log();
  }
}

/**
 * 主入口
 */
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    checkCoverage();
    return;
  }

  if (args.includes('--add')) {
    const idx = args.indexOf('--add');
    const entry = args[idx + 1];
    if (!entry) {
      console.error('用法：--add "术语|科目|章节"');
      process.exit(1);
    }
    const parts = entry.split('|').map(s => s.trim());
    if (parts.length !== 3) {
      console.error('格式错误，应为：术语|科目|章节');
      process.exit(1);
    }
    const line = `| ${parts[0]} | ${parts[1]} | ${parts[2]} |\n`;
    fs.appendFileSync(KEYWORD_PATH, line);
    console.log(`[OK] 已追加术语：${parts[0]}`);
    return;
  }

  // 默认：从大纲重建索引（输出到控制台）
  if (!fs.existsSync(SYLLABUS_PATH)) {
    console.error('[ERROR] 请先创建 408-syllabus-outline.md');
    process.exit(1);
  }

  const syllabusMd = fs.readFileSync(SYLLABUS_PATH, 'utf-8');
  const terms = extractTermsFromSyllabus(syllabusMd);
  const output = formatIndex(terms);

  console.log(output);
  console.log(`\n[INFO] 共提取 ${terms.length} 个术语条目（去重前），${new Set(terms.map(t => `${t.term}|${t.subject}|${t.chapter}`)).size} 个去重后条目。`);
  console.log('[INFO] 如需覆盖 keyword-index.md，运行：');
  console.log(`  node scripts/build-keyword-index.js > references/408-keyword-index.md`);
}

main();
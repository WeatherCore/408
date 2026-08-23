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

// 科目中文序号（生成小节标题 "## 一、数据结构（DS）" 用，与 keyword-index.md 现有格式一致）
const SUBJECT_ORDINAL = ['一', '二', '三', '四'];

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

    // 检测章节标题（### N. 章节名），章节编号与现表格式对齐（如 "1-线性表"）
    const chapterMatch = line.match(/^###\s+(\d+)[.、\s]+(.+)$/);
    if (chapterMatch && currentSubject) {
      currentChapter = `${chapterMatch[1]}-${chapterMatch[2].trim()}`;
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

  let output = `# 408 术语→科目→章节映射索引（自动生成）\n\n`;
  output += `> 由 build-keyword-index.js 从考纲大纲自动提取。\n`;
  output += `> ⚠️ 本文件为生成产物，输出到新文件与手工索引 diff 合并；\n`;
  output += `> **不要直接覆盖 references/408-keyword-index.md**（其中含手工维护的关联度与跨科映射）。\n\n`;

  // 科目按 大纲顺序（= SUBJECT_MAP 插入顺序）分组，标题对齐手工索引的 "## 一、数据结构（DS）" 格式
  const grouped = {};
  const subjectOrder = [];
  for (const t of unique) {
    if (!grouped[t.subject]) { grouped[t.subject] = []; subjectOrder.push(t.subject); }
    grouped[t.subject].push(t);
  }

  for (const subject of subjectOrder) {
    const cnName = Object.keys(SUBJECT_MAP).find(k => SUBJECT_MAP[k] === subject) || subject;
    const ordinal = SUBJECT_ORDINAL[Object.keys(SUBJECT_MAP).indexOf(cnName)] || '';
    output += `---\n\n## ${ordinal}、${cnName}（${subject}）\n\n`;
    // 列结构对齐手工索引（术语|章节|关联度）；自动提取无关联度数据，统一填 ★
    output += `| 术语 | 章节 | 关联度 |\n|------|------|-------|\n`;
    for (const t of grouped[subject]) {
      output += `| ${t.term} | ${t.chapter} | ★ |\n`;
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
      console.error('用法：--add "术语|科目|章节[|关联度]"（科目：ds/co/os/net 或中文名；关联度缺省 ★）');
      process.exit(1);
    }
    const parts = entry.split('|').map(s => s.trim());
    if (parts.length < 3 || parts.length > 4) {
      console.error('格式错误，应为：术语|科目|章节[|关联度]');
      process.exit(1);
    }
    const [term, subjectIn, chapter, relevance] = parts;
    if (!term || !chapter) {
      console.error('格式错误：术语与章节不能为空');
      process.exit(1);
    }
    const code = SUBJECT_MAP[subjectIn] || String(subjectIn).toUpperCase();
    if (!Object.values(SUBJECT_MAP).includes(code)) {
      console.error(`格式错误：未知科目 "${subjectIn}"（应为 ds/co/os/net 或 数据结构/计算机组成原理/操作系统/计算机网络）`);
      process.exit(1);
    }
    if (!fs.existsSync(KEYWORD_PATH)) {
      console.error('[ERROR] 关键词索引文件不存在：', KEYWORD_PATH);
      process.exit(1);
    }

    // 定位科目小节（"## 一、数据结构（DS）"），把新行插到该小节最后一个表格行之后，
    // 保持 3 列格式（术语|章节|关联度）与按科目分组的结构；绝不追加到文件末尾
    // （文件尾部是跨科映射代码块，旧实现会把行插进代码块、且列数错位）
    const lines = fs.readFileSync(KEYWORD_PATH, 'utf-8').split('\n');
    const headerRe = /^##\s+/;
    const sectionRe = new RegExp(`^##\\s+.*（${code}）\\s*$`);
    let sectionStart = lines.findIndex(l => sectionRe.test(l));
    if (sectionStart === -1) {
      console.error(`[ERROR] 索引中未找到 ${code} 科目小节（应形如 "## 一、xx（${code}）"），请检查文件结构`);
      process.exit(1);
    }
    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (headerRe.test(lines[i])) { sectionEnd = i; break; }
    }
    let insertAt = -1;
    for (let i = sectionEnd - 1; i > sectionStart; i--) {
      if (lines[i].startsWith('|') && !/^\|\s*-{2,}/.test(lines[i])) { insertAt = i + 1; break; }
    }
    if (insertAt === -1) {
      console.error(`[ERROR] ${code} 小节内未找到表格行，无法确定插入位置，请手动添加`);
      process.exit(1);
    }
    lines.splice(insertAt, 0, `| ${term} | ${chapter} | ${relevance || '★'} |`);
    fs.writeFileSync(KEYWORD_PATH, lines.join('\n'), 'utf-8');
    console.log(`[OK] 已在 ${code} 小节追加术语：${term}（${chapter}）`);
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
  console.log('[INFO] 如需与现有索引对照合并，输出到**新文件**后 diff（现有索引含手工维护的关联度与跨科映射，勿直接覆盖）：');
  console.log(`  node scripts/build-keyword-index.js > references/408-keyword-index.generated.md`);
  console.log(`  git diff --no-index references/408-keyword-index.md references/408-keyword-index.generated.md`);
}

main();
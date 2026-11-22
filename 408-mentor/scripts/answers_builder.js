#!/usr/bin/env node

/**
 * answers_builder.js — 官方答案速查表构建工具
 *
 * 把 17 年答案 PDF 的「选择题答案字母」与「综合题答案起始页码」固化为
 * references/exam-archive/answers.json，运行时模型查表代替高风险的"渲染答案页→视觉读图"。
 *
 * 数据来源与可信度：
 *   - 有文本层年份（2019/2021/2024/2025 之外全部）：解析 extracted-text/<年>-answer.txt
 *     的选择题速查表（两种排版：2012 式 "N.\n字母"、2020 式零填充 "NN.\n字母"）→ source: "text"，可信
 *   - 扫描版年份（2019/2021/2024/2025）：OCR 文本答案表乱码严重（禁止当答案来源），
 *     选择题答案留空待视觉读取回填（needsVisual: true）；综合题页码从 OCR 文本的
 *     页标记 + 题号定位，仅作"渲染哪一页"的导航提示（OCR 定位页码可靠，读字不可靠）
 *
 * 用法：
 *   node scripts/answers_builder.js            # 构建/更新 answers.json（保留已有 visual 数据）
 *   node scripts/answers_builder.js --check    # 只做完整性校验（CI 用），不写文件
 *
 * 完整性目标：40 choice × 17 年 + 7 comprehensive × 17 年。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEXT_DIR = path.join(ROOT, 'references', 'exam-archive', 'extracted-text');
const OUT_PATH = path.join(ROOT, 'references', 'exam-archive', 'answers.json');

const YEARS = Array.from({ length: 2025 - 2009 + 1 }, (_, i) => 2009 + i);
const SCAN_YEARS = new Set([2019, 2021, 2024, 2025]); // 答案 PDF 无文本层的年份

/**
 * 解析选择题答案（1-40）。真题答案 PDF 实测存在三种排版：
 *
 *   A. 题号紧邻字母（2012/2020-2023 等）："1. \nB"、"01.\nC"（零填充）
 *   B. 网格答案表（2009-2011、2013-2018 等）：题号按 8 行 × 5 列排布
 *      （行 r 的题号为 r, r+8, r+16, r+24, r+32），字母以 5 个一组的字母串出现，
 *      字母串与题号的相对顺序不固定（2011 八组连排、2010 与题号行穿插）
 *
 * 解析策略：
 *   第 1 步——全文件扫描排版 A（题号后紧跟字母行，首次出现优先；答案表必在解析正文之前）；
 *   第 2 步——仍缺时回退排版 B：在压缩空白后的文本中找 [A-D]{5,} 极大字母串，
 *   按 5 个一组切块，第 j 块 → 第 j 行（题号 j, j+8, ... j+32）。
 *   风险控制：先在「解析」首次出现之前的区域找字母串（表格必在解析前）；
 *   全文件兜底时若串总量 ≠ 8 行仍在结果上标记 needsVisual 供人工校验。
 */
function parseChoiceAnswers(text) {
  const answers = {};

  // 第 1 步：排版 A——题号后紧跟字母（允许 \r\n 与空格），首次出现优先
  const reA = /(\d{1,2})\s*[.、．]\s*\r?\n\s*([A-Da-d])(?![A-Za-z])/g;
  let m;
  while ((m = reA.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    if (num >= 1 && num <= 40 && !(num in answers)) {
      answers[num] = m[2].toUpperCase();
    }
  }

  // 第 1.5 步：排版 C——逐题解析格式 "N.【参考答案】X"（2023 等），字母同行紧跟
  const reC = /(\d{1,2})\s*[.、．]\s*【参考答案】\s*([A-Da-d])(?![A-Za-z])/g;
  while ((m = reC.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    if (num >= 1 && num <= 40 && !(num in answers)) {
      answers[num] = m[2].toUpperCase();
    }
  }

  // 第 2 步：排版 B——字母串切块 → 行映射。
  // 关键对齐规则（2009 实证）：块按文档序对应「从首个未填满行开始」的升序行——
  // A 步已内联抓到的行（如 2009 第 1 行）不再占用块；从第 1 行硬起映射会整体错位一行。
  // 安全策略（2016 实证）：网格块可能整行缺失（OCR 漏读），顺序映射会把后续行整体错位
  // → 静默错数据。因此网格结果必须与 A 步内联锚点交叉验证，任一冲突即整年拒绝网格数据。
  let gridRejected = false;
  if (Object.keys(answers).length < 40) {
    // A 步锚点：仅收集「解析」首次出现之前的内联 (题号, 字母)——解析正文里的
    // "40. \nD" 式巧合是假锚点（2022 实证），会把正确的网格映射误杀
    const anchors = {};
    let anchorRegion = text;
    const jxAll = text.indexOf('解析');
    if (jxAll > 0) anchorRegion = text.slice(0, jxAll);
    const reAnchor = /(\d{1,2})\s*[.、．]\s*\r?\n\s*([A-Da-d])(?![A-Za-z])/g;
    while ((m = reAnchor.exec(anchorRegion)) !== null) {
      const num = parseInt(m[1], 10);
      if (num >= 1 && num <= 40 && !(num in anchors)) anchors[num] = m[2].toUpperCase();
    }

    let firstUnfilled = 1;
    for (let r = 1; r <= 8; r++) {
      const rowCells = [r, r + 8, r + 16, r + 24, r + 32];
      if (rowCells.some((n) => !(n in answers))) { firstUnfilled = r; break; }
    }
    // 解析区域起点（表格字母必在解析之前；找不到则用全文兜底）
    let region = text;
    const jxStart = text.search(/1\s*[.、．]\s*解析|解析[:：]/);
    if (jxStart > 0) region = text.slice(0, jxStart);
    // 压缩所有空白后找极大 A-D 字母串（连排多行会合并为一个长串，按 5 切块）
    const findRuns = (s) => {
      const squashed = s.replace(/\s+/g, '');
      const runs = [];
      const re = /[A-Da-d]{5,}/g;
      let r;
      while ((r = re.exec(squashed)) !== null) runs.push(r[0]);
      return runs;
    };
    // 区域字母量不足以覆盖剩余行时，回退全文（解析体的 4 字母词组低于 5 长度阈值，误检概率低）
    const needed = (8 - firstUnfilled + 1) * 5;
    let runs = findRuns(region);
    if (runs.join('').length < needed) runs = findRuns(text);
    const blocks = [];
    for (const run of runs) {
      for (let i = 0; i + 5 <= run.length; i += 5) {
        blocks.push(run.slice(i, i + 5).toUpperCase());
      }
    }

    // 交叉验证：每个块与其假设行的 A 步锚点比对，任一冲突 → 网格整体不可信
    let conflict = false;
    for (let j = 0; j < blocks.length && !conflict; j++) {
      const row = firstUnfilled + j;
      if (row > 8) break;
      for (let c = 0; c < 5; c++) {
        const num = row + c * 8;
        if (num in anchors && anchors[num] !== blocks[j][c]) { conflict = true; break; }
      }
    }
    if (conflict) {
      gridRejected = true;
    } else {
      // 块 j → 行 firstUnfilled + j；列保持对齐（c 索引不变），已填单元格跳过（首次优先）
      for (let j = 0; j < blocks.length; j++) {
        const row = firstUnfilled + j;
        if (row > 8) break;
        for (let c = 0; c < 5; c++) {
          const num = row + c * 8;
          if (!(num in answers)) answers[num] = blocks[j][c];
        }
      }
    }
  }

  // 网格被拒绝时清空数据——宁可留空待视觉读取，绝不带着错位风险交付
  if (gridRejected) {
    for (const k of Object.keys(answers)) delete answers[k];
  }

  return answers;
}

/**
 * 定位综合题（41-47）答案的起始页码。
 * 扫描每页文本，找 "41."–"47." 题号标记的首次出现页（1 基）。
 * OCR 质量差可能吞掉个别题号，找不到就置 null（渲染时按邻近页兜底）。
 */
function parseCompPages(text) {
  const pages = text.split(/===\s*第\s*(\d+)\s*页\s*===/);
  // pages 形如 [前导, '1', 页1文本, '2', 页2文本, ...]
  const result = {};
  for (let i = 1; i < pages.length; i += 2) {
    const pageNo = parseInt(pages[i], 10);
    const body = pages[i + 1] || '';
    for (let q = 41; q <= 47; q++) {
      if (result[q] !== undefined) continue;
      const re = new RegExp(`(?:^|\\n)\\s*${q}\\s*[.、．]`);
      if (re.test(body)) result[q] = pageNo;
    }
  }
  return result;
}

function build() {
  const years = {};
  for (const year of YEARS) {
    const file = path.join(TEXT_DIR, `${year}-answer.txt`);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      console.error(`[ERROR] 缺少 ${year}-answer.txt，跳过 ${year}`);
      continue;
    }

    const scanned = SCAN_YEARS.has(year);
    const choice = scanned ? {} : parseChoiceAnswers(text);
    const compPages = parseCompPages(text);

    const choiceMissing = [];
    for (let n = 1; n <= 40; n++) {
      if (!scanned && !choice[n]) choiceMissing.push(n);
    }
    const compMissing = [];
    for (let n = 41; n <= 47; n++) {
      if (compPages[n] === undefined) compMissing.push(n);
    }

    years[year] = {
      scanned,
      choiceAnswers: scanned ? {} : choice,
      comprehensivePages: compPages,
      needsVisual: scanned || choiceMissing.length > 0,
      ...(scanned ? { visualTodo: { choiceAnswers: true } } : {}),
      ...(choiceMissing.length ? { choiceMissing: choiceMissing } : {}),
      ...(compMissing.length ? { compPageMissing: compMissing } : {}),
    };
  }

  return { version: '1', years };
}

/**
 * 完整性校验：每年 40 个选择题答案 + 7 个综合题页码；扫描年 choice 允许 needsVisual 待回填
 */
function check(data) {
  let ok = true;
  const problems = [];
  for (const year of YEARS) {
    const y = data.years[year];
    if (!y) { problems.push(`${year}: 缺失整年`); ok = false; continue; }
    const choiceCount = Object.keys(y.choiceAnswers || {}).length;
    const compCount = Object.keys(y.comprehensivePages || {}).length;
    if (y.scanned) {
      // 扫描年允许两种终态：① 尚未视觉回填（choice 空 + needsVisual）；② 已视觉回填（source: visual 且 40 题全）
      const visualDone = y.source === 'visual' && choiceCount === 40;
      if (!visualDone && choiceCount !== 0) problems.push(`${year}: 扫描年不应有 text 来源的 choice 答案`);
      if (!visualDone && !y.needsVisual) { problems.push(`${year}: 扫描年 needsVisual 应为 true`); ok = false; }
      if (visualDone && !y.verified) { problems.push(`${year}: 视觉回填的扫描年应带 verified 标记`); ok = false; }
    } else if (choiceCount !== 40) {
      problems.push(`${year}: choice ${choiceCount}/40`);
      ok = false;
    }
    if (compCount < 7 && !(y.compPageMissing || []).length) {
      problems.push(`${year}: compPages ${compCount}/7 但未声明缺失`);
      ok = false;
    }
    if ((y.compPageMissing || []).length >= 7) {
      problems.push(`${year}: 综合题页码全部缺失（OCR 定位失败，需人工）`);
      ok = false;
    }
  }
  return { ok, problems };
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');

  // --check 时优先校验已有文件（构建是开发期动作，CI 只验证产物）
  let data;
  if (checkOnly && fs.existsSync(OUT_PATH)) {
    data = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
  } else {
    data = build();
  }

  const { ok, problems } = check(data);
  const totalChoice = Object.values(data.years).reduce((s, y) => s + Object.keys(y.choiceAnswers || {}).length, 0);
  const totalComp = Object.values(data.years).reduce((s, y) => s + Object.keys(y.comprehensivePages || {}).length, 0);
  const yearsCovered = Object.keys(data.years).length;

  console.log(`📊 answers.json 完整性：${yearsCovered}/17 年 | choice ${totalChoice}/${17 * 40} | compPages ${totalComp}/${17 * 7}`);
  if (problems.length) {
    console.log('⚠️ 问题清单：');
    problems.forEach((p) => console.log(`   - ${p}`));
  }

  if (checkOnly) {
    if (!ok) process.exit(1);
    console.log('✅ 校验通过');
    return;
  }

  // 非 check：合并写入。若已有文件，保留其中 visual 来源的数据（choiceAnswersVisual / 已人工校验标记）
  if (fs.existsSync(OUT_PATH)) {
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
    for (const [year, prevY] of Object.entries(prev.years || {})) {
      const cur = data.years[year];
      if (!cur) continue;
      if (prevY.choiceAnswersVisual) {
        cur.choiceAnswers = prevY.choiceAnswersVisual; // 视觉回填优先于一切
        cur.source = 'visual';
        cur.needsVisual = false;
        delete cur.visualTodo;
        delete cur.choiceMissing;
      }
      if (prevY.verified) cur.verified = prevY.verified;
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`💾 已写入 ${OUT_PATH}`);
  if (!ok) process.exit(1);
}

main();

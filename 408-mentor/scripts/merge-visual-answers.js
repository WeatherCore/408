#!/usr/bin/env node
/**
 * 一次性合并脚本：把 2026-11-16 视觉核验的 17 年选择题答案表写入 answers.json
 * （每张表来自答案 PDF 首页 150dpi 渲染图的视觉读取，部分年份与解析正文「故选X」交叉验证）
 * 运行后再执行 node scripts/answers_builder.js 完成 merge（visual 优先于 text）。
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'references', 'exam-archive', 'answers.json');

// 每年 5 行 × 8 题（按答案页表格行序），视觉读取结果
const VISUAL = {
  2009: ['BCDBCBAD', 'ABCDDCDC', 'AADBDADD', 'CACBAABA', 'BBCADDCA'],
  2010: ['DCDCBACB', 'BDADBBDA', 'DBADADAC', 'BADBBCCB', 'CCDCBDAA'],
  2011: ['ABBCCDAC', 'DABDABDA', 'CDCCDCBA', 'DBDDACBC', 'ABBDDCCB'],
  2012: ['BAABCCCA', 'DADDBDDA', 'CCCDDBCB', 'BADABCAB', 'BCABCADD'],
  2013: ['DCDBACCD', 'CACCAACA', 'DCBBBDAA', 'CACBDBBB', 'BADBABBA'],
  2014: ['CBADCDDD', 'DBC DCAAD'.replace(/ /g, ''), 'ACCCDBAB', 'DAACBACD', 'CBDCBABD'],
  2015: ['ABDDDCAC', 'CCAABDCB', 'BDCBBDBC', 'DBAABCCC', 'DABBACAC'],
  2016: ['DDCBCDBB', 'BADCDACC', 'CBBAAAAB', 'CABDACDA', 'CCDBBDCC'],
  2017: ['BCABBDBA', 'BBDCCADA', 'CBADDBDC', 'BDBDBDBB', 'ADBADCAC'],
  2018: ['BCAAACDB', 'CDADCAAB', 'CBADBCCD', 'BACDDADC', 'BCDDDCBD'],
  2019: ['BBCACADC', 'BDBCADDD', 'BCBCADBC', 'CBCBCBAC', 'CABBBCDB'],
  2020: ['CDACBBAB', 'CBABADDA', 'BACCBCBA', 'DDBDBDBC', 'CBCDADCD'],
  2021: ['DDBCBDAC', 'ACBDDACA', 'DCCABABB', 'CCDCBACC', 'BABBDBDC'],
  2022: ['BDBC DDBD'.replace(/ /g, ''), 'DADABACA', 'CBDACCDA', 'CBCDADBA', 'BCBDBCDB'],
  2023: ['DCABABBB', 'CCDCAACB', 'ABCDDCDA', 'CDCDBCBD', 'DCBCDABD'],
  2024: ['DAABDADA', 'BCDBBCDC', 'CBCBACAA', 'DAABACCC', 'BCDBDDCD'],
  2025: ['BDDBDCCC', 'ADADDDCB', 'CBAABADC', 'CBDCCACB', 'BCCCBABA'],
};

// 自检：每年 5 行、每行 8 个 A-D
let ok = true;
for (const [year, rows] of Object.entries(VISUAL)) {
  if (rows.length !== 5 || rows.some((r) => r.length !== 8 || !/^[A-D]+$/.test(r))) {
    console.error(`[ERROR] ${year} 视觉表格式异常`);
    ok = false;
  }
}
if (!ok) process.exit(1);

const data = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
for (const [year, rows] of Object.entries(VISUAL)) {
  const y = data.years[year];
  if (!y) continue;
  const map = {};
  rows.forEach((row, r) => {
    for (let c = 0; c < 8; c++) map[r * 8 + c + 1] = row[c];
  });
  y.choiceAnswersVisual = map;
  y.verified = true;
}
data.verification = {
  verifiedAt: '2026-11-16',
  method: '视觉读取 17 年答案 PDF 首页（150dpi 渲染）的选择题答案表',
  crossChecks: '2009/2010/2011/2012/2013/2014/2015/2017/2018/2019/2020/2021/2022/2023 的解析正文「故选X」与表内对应题号一致',
  coverage: '17/17 年 × 40 题',
};
fs.writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf-8');
console.log('✅ 17 年视觉核验表已写入 answers.json（choiceAnswersVisual + verified），运行 answers_builder.js 完成 merge');

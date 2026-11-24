#!/usr/bin/env node

/**
 * smoke-test.js
 *
 * 408-mentor 画像与弱项计算的冒烟测试。
 * 在临时目录中创建画像，模拟做题，验证 weakTopics 自动维护逻辑。
 *
 * 用法：node scripts/smoke-test.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const NODE = process.execPath;
const SCRIPT = path.join(__dirname, 'profile-manager.js');
const TEST_DIR = path.join(require('os').tmpdir(), `408-mentor-smoke-${Date.now()}`);

// 索引相关路径
const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'references', 'exam-archive', 'exam-index.json');

function run(args) {
  const out = execFileSync(NODE, [SCRIPT, '--cwd', TEST_DIR, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

// 期望命令失败：返回退出码与 stderr（execFileSync 在非 0 退出码时抛异常）
function runFail(args) {
  try {
    execFileSync(NODE, [SCRIPT, '--cwd', TEST_DIR, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.status, stderr: e.stderr || '' };
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${msg}`);
}

function cleanup() {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function main() {
  return mainAsync().finally(cleanup);
}

async function mainAsync() {
  console.log(`测试目录: ${TEST_DIR}\n`);
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // 1. init
    const initRes = run(['init', '--subject', 'os', '--level', 'review']);
    assert(initRes.ok && initRes.profile.level === 'review', 'init 创建 review 等级画像');

    // 2. read
    const readRes = run(['read']);
    assert(readRes && readRes.level === 'review' && readRes.weakTopics.length === 0, 'read 返回画像且 weakTopics 为空');

    // 3. 连续答错 3 次同一 topic，应进入 weakTopics
    for (let i = 0; i < 3; i++) {
      run(['update-question', '--chapter', 'OS-内存管理', '--topic', '虚拟内存', '--correct', 'false', '--difficulty', 'medium']);
    }
    const weakRes = run(['read']);
    assert(
      weakRes.weakTopics.some((w) => w.topic === '虚拟内存' && w.totalCount === 3 && w.correctRate === 0),
      '连续错 3 次后，虚拟内存进入 weakTopics'
    );

    // 4. 连续答对 4 次，把正确率拉回 4/7，应退出 weakTopics
    for (let i = 0; i < 4; i++) {
      run(['update-question', '--chapter', 'OS-内存管理', '--topic', '虚拟内存', '--correct', 'true', '--difficulty', 'medium']);
    }
    const recoveredRes = run(['read']);
    assert(
      !recoveredRes.weakTopics.some((w) => w.topic === '虚拟内存'),
      '正确率回升后，虚拟内存退出 weakTopics'
    );

    // 4.5 --correct 非规范值应被严格拒绝（防静默记为答错污染画像）
    const badCorrect = runFail(['update-question', '--chapter', 'OS-内存管理', '--topic', '虚拟内存', '--correct', 'True', '--difficulty', 'medium']);
    assert(
      badCorrect.code !== 0 && /无效 correct/.test(badCorrect.stderr),
      '--correct True 被拒绝并报错（不静默记为答错）'
    );
    const afterBad = run(['read']);
    assert(afterBad.stats.totalQuestions === 7, '被拒绝的记录未写入画像');

    // 4.6 并发写入：5 条并发 update-question，写锁串行化后应全部落盘（防丢更新）
    const children = [];
    for (let i = 0; i < 5; i++) {
      children.push(spawn(NODE, [SCRIPT, '--cwd', TEST_DIR, 'update-question', '--chapter', 'DS-排序', '--topic', `堆排变式${i}`, '--correct', 'true', '--difficulty', 'easy'], { stdio: 'ignore' }));
    }
    const codes = await Promise.all(children.map((c) => new Promise((res) => c.on('exit', (code) => res(code)))));
    assert(codes.every((c) => c === 0), `5 条并发 update-question 全部成功退出（实际退出码: ${codes.join(',')}）`);
    const afterConc = run(['read']);
    assert(
      afterConc.stats.totalQuestions === 12 && afterConc.questionLog.filter((e) => e.topic.startsWith('堆排变式')).length === 5,
      '并发写入的 5 条记录全部落盘（写锁生效，无丢更新）'
    );

    // 4.7 update-level 三个分支：真实变更 / 同级 user_declared 重申 / 同级 phrasing 噪音
    const lv1 = run(['update-level', '--level', 'sprint', '--reason', 'user_declared']);
    assert(lv1.changed === true && lv1.level === 'sprint', 'update-level 真实变更返回 changed=true');
    const histLen = lv1.levelHistory.length;
    const lv2 = run(['update-level', '--level', 'sprint', '--reason', 'user_declared']);
    assert(
      lv2.changed === false && lv2.recorded === true && lv2.levelHistory.length === histLen + 1,
      '同级 user_declared 重申写入轨迹（自述信号不丢）'
    );
    const lv3 = run(['update-level', '--level', 'sprint', '--reason', 'phrasing_escalation']);
    assert(
      lv3.changed === false && lv3.recorded === false && lv3.levelHistory.length === histLen + 1,
      '同级 phrasing 信号不入轨迹（防噪音刷史）'
    );

    // 4.8 subjects 多值化：init 单科目 os，4.6 已写入 DS 章节记录，subjects 应自动并入 ds，旧 subject 字段移除
    const subjRes = run(['read']);
    assert(
      Array.isArray(subjRes.subjects) && subjRes.subjects.includes('os') && subjRes.subjects.includes('ds') && subjRes.subject === undefined,
      `subjects 多值：跨科记录自动并入（实际 [${(subjRes.subjects || []).join(',')}]）`
    );

    // 4.9 v1→v2 迁移：手写一份 v1 画像（单值 subject），read 应内存升级；下次写盘时 version/结构持久化
    const profilePath = path.join(TEST_DIR, '.408-mentor', 'profile.json');
    const v1Profile = {
      version: '1',
      subject: 'net',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      level: 'beginner',
      levelHistory: [{ level: 'beginner', setAt: '2025-01-01T00:00:00.000Z', reason: 'user_declared' }],
      stats: { totalQuestions: 0, correct: 0, wrong: 0, byChapter: {} },
      questionLog: [],
      weakTopics: [],
    };
    fs.writeFileSync(profilePath, JSON.stringify(v1Profile, null, 2), 'utf-8');
    const migrated = run(['read']);
    assert(
      migrated.version === '2' && Array.isArray(migrated.subjects) && migrated.subjects[0] === 'net' && migrated.subject === undefined,
      'v1 画像读取时自动迁移为 v2（subject→subjects，version 升 2）'
    );
    run(['update-level', '--level', 'review', '--reason', 'user_declared']);
    const persisted = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    assert(
      persisted.version === '2' && persisted.subject === undefined && persisted.subjects[0] === 'net',
      '迁移结构在下次变更写盘时持久化（version 字段落地）'
    );

    // 4.10 questionLog 归档：塞 2050 条历史记录，再写 1 条应触发溢出归档（主日志回到 2000，51 条进归档文件）
    const bigLog = Array.from({ length: 2050 }, (_, i) => ({
      timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
      chapter: 'OS-内存管理',
      topic: '归档测试',
      correct: i % 2 === 0,
      difficulty: 'easy',
    }));
    const cur = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    cur.questionLog = bigLog;
    fs.writeFileSync(profilePath, JSON.stringify(cur, null, 2), 'utf-8');
    const archRes = run(['update-question', '--chapter', 'OS-内存管理', '--topic', '归档测试', '--correct', 'true', '--difficulty', 'easy']);
    const archiveFile = path.join(TEST_DIR, '.408-mentor', 'questionLog.archive.json');
    const archivedEntries = JSON.parse(fs.readFileSync(archiveFile, 'utf-8'));
    const afterArch = run(['read']);
    assert(
      archRes.ok && archRes.archivedToLog === 51 && afterArch.questionLog.length === 2000 && archivedEntries.length === 51,
      `questionLog 超限归档（主日志 ${afterArch.questionLog.length} 条，归档 ${archivedEntries.length} 条）`
    );

    // 5. reset
    const resetRes = run(['reset']);
    assert(resetRes.reset === true && !fs.existsSync(path.join(TEST_DIR, '.408-mentor', 'profile.json')), 'reset 删除画像文件');
    assert(resetRes.archivedRemoved === true && !fs.existsSync(archiveFile), 'reset 同时删除归档文件（清除学习记录覆盖全部做题数据）');

    // 6. 索引完整性（无需画像目录，直接读仓库索引）
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    const questions = index.questions || [];

    assert(questions.length >= 799 && questions.length % 47 === 0, `索引题数 >=799 且为每年 47 题的整数倍（实际 ${questions.length}）`);
    assert(!questions.some(q => 'answerPage' in q), '索引中不存在 answerPage 死字段');
    assert(questions.every(q => q.examPage && q.examPage > 0), '所有题 examPage > 0');
    assert(questions.every(q => q.rawText && q.rawText.length >= 10), '所有题 rawText 非空');
    assert(!questions.some(q => q.rawText && q.rawText.includes('=== 第')), 'rawText 不含页标记残留');
    const clipCount = questions.filter(q => q.clip && Array.isArray(q.clip)).length;
    assert(clipCount >= Math.floor(0.99 * questions.length), `clip 覆盖率 ≥ 99%（实际 ${clipCount}/${questions.length}）`);

    // 7. 搜索排名："虚拟内存" 应优先 topics 命中的题目（2023/2012/2011）而非 rawText 命中的 VFS 题
    const { execSync } = require('child_process');
    const searchOut = execSync(`"${NODE}" "${path.join(ROOT, 'scripts', 'exam-pdf-loader.js')}" search 虚拟内存`, { encoding: 'utf-8', cwd: ROOT });
    const firstLine = searchOut.split('\n').find(l => l.trim().startsWith('['));
    assert(firstLine && firstLine.includes('2023'), `搜索 虚拟内存 首条为 topics 命中（实际首条: ${firstLine}`);

    // 8. question_clip shot：抽一道题渲染 PNG，验证核心交付路径（学生实际看到的单题截图）
    //    依赖 PyMuPDF venv；venv launcher 指向已删除的 base python 时 SKIP 而非 FAIL
    //    （环境依赖，非逻辑缺陷；运行 scripts/pdfcraft/setup.bat 修复后可真正执行）
    const shotOut = path.join(TEST_DIR, 'shots');
    const qcScript = path.join(ROOT, 'scripts', 'question_clip.py');
    const venvPy = path.join(ROOT, 'scripts', 'pdfcraft', 'venv', 'Scripts', 'python.exe');
    const pyBin = fs.existsSync(venvPy) ? venvPy : 'python';
    let venvReady = true;
    try {
      execSync(`"${pyBin}" -c "import fitz"`, { encoding: 'utf-8', timeout: 15000 });
    } catch (e) {
      venvReady = false;
      console.log(`⏭️  SKIP: question_clip shot（PyMuPDF venv 不可用：${(e.message || '').split('\n')[0]}）`);
      console.log(`    修复：运行 scripts\\pdfcraft\\setup.bat 重建 venv（已内置健康自检，会自动检测并修复损坏的 python 指向）`);
    }
    if (venvReady) {
      try {
        execSync(`"${pyBin}" "${qcScript}" shot 2023 28 "${shotOut}"`, { encoding: 'utf-8', cwd: ROOT, timeout: 60000 });
        const pngPath = path.join(shotOut, '2023_Q28.png');
        assert(fs.existsSync(pngPath), 'question_clip shot 生成 PNG 文件');
        const stat = fs.statSync(pngPath);
        assert(stat.size > 10240, `shot PNG 体积合理（>10KB，实际 ${(stat.size / 1024).toFixed(1)}KB）`);
      } catch (e) {
        assert(false, `question_clip shot 执行失败：${e.message.split('\n')[0]}`);
      }
    }

    // 9. 多关键词 AND 语义 + topics 命中权重
    //    正向：共现子串（虚拟+内存）应命中；负向：不共现词应返回空（证明 AND 非 OR）
    const andHit = execSync(`"${NODE}" "${path.join(ROOT, 'scripts', 'exam-pdf-loader.js')}" search 虚拟 内存`, { encoding: 'utf-8', cwd: ROOT });
    const hitLines = andHit.split('\n').filter(l => l.trim().startsWith('['));
    assert(hitLines.length > 0, `共现词 AND 返回结果（虚拟+内存，实际 ${hitLines.length} 条）`);
    const andMiss = execSync(`"${NODE}" "${path.join(ROOT, 'scripts', 'exam-pdf-loader.js')}" search 虚拟内存 哈夫曼`, { encoding: 'utf-8', cwd: ROOT });
    const missLines = andMiss.split('\n').filter(l => l.trim().startsWith('['));
    assert(missLines.length === 0, `不共现词 AND 返回空（证明 AND 非 OR，实际 ${missLines.length} 条）`);
    const singleOut2 = execSync(`"${NODE}" "${path.join(ROOT, 'scripts', 'exam-pdf-loader.js')}" search 虚拟内存`, { encoding: 'utf-8', cwd: ROOT });
    const singleFirst = singleOut2.split('\n').find(l => l.trim().startsWith('['));
    const scoreMatch = singleFirst && singleFirst.match(/得分(\d+)/);
    assert(scoreMatch && parseInt(scoreMatch[1], 10) >= 10, `首条为 topics 命中（得分>=10，实际 ${scoreMatch ? scoreMatch[1] : '无'}）`);

    // 10. --syn 同义词组扩展：同根异写词（快排≡快速排序）应显著扩大召回，且原词行为不变
    const plainOut = execSync(`"${NODE}" "${path.join(ROOT, 'scripts', 'exam-pdf-loader.js')}" search 快排`, { encoding: 'utf-8', cwd: ROOT });
    const plainCount = parseInt((plainOut.match(/（AND）：(\d+) 条结果/) || [])[1] || '0', 10);
    const synOut = execSync(`"${NODE}" "${path.join(ROOT, 'scripts', 'exam-pdf-loader.js')}" search --syn 快排`, { encoding: 'utf-8', cwd: ROOT });
    const synCount = parseInt((synOut.match(/条结果/) ? (synOut.match(/：(\d+) 条结果/) || [])[1] : '0'), 10) || parseInt((synOut.match(/（AND \+ 同义扩展）：(\d+) 条结果/) || [])[1] || '0', 10);
    const synExpanded = synOut.includes('同义扩展') && synOut.includes('≡快速排序');
    assert(synExpanded && synCount > plainCount, `--syn 同义扩展扩大召回（快排 ${plainCount} → ${synCount} 条，标注含 ≡快速排序）`);

    // 11. --syn 组内命中参与 AND：TLB+虚拟内存 直查为空（索引用词是 页式虚拟存储/虚拟地址），
    //     --syn 后经 TLB≡快表、虚拟内存≡虚拟存储器/页式虚拟存储 扩展应真实共现
    const synAndMiss = execSync(`"${NODE}" "${path.join(ROOT, 'scripts', 'exam-pdf-loader.js')}" search TLB 虚拟内存`, { encoding: 'utf-8', cwd: ROOT });
    const missBefore = parseInt((synAndMiss.match(/（AND）：(\d+) 条结果/) || [])[1] || '0', 10);
    const synAnd = execSync(`"${NODE}" "${path.join(ROOT, 'scripts', 'exam-pdf-loader.js')}" search --syn TLB 虚拟内存`, { encoding: 'utf-8', cwd: ROOT });
    const synAndCount = parseInt((synAnd.match(/（AND \+ 同义扩展）：(\d+) 条结果/) || [])[1] || '0', 10);
    assert(missBefore === 0 && synAndCount > 0, `--syn 组内命中参与 AND（TLB+虚拟内存：直查 ${missBefore} 条 → 同义扩展 ${synAndCount} 条）`);

    console.log('\n🎉 所有冒烟测试通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

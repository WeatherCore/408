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

    // 5. reset
    const resetRes = run(['reset']);
    assert(resetRes.reset === true && !fs.existsSync(path.join(TEST_DIR, '.408-mentor', 'profile.json')), 'reset 删除画像文件');

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

    console.log('\n🎉 所有冒烟测试通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

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

    // 5. reset
    const resetRes = run(['reset']);
    assert(resetRes.reset === true && !fs.existsSync(path.join(TEST_DIR, '.408-mentor', 'profile.json')), 'reset 删除画像文件');

    console.log('\n🎉 所有冒烟测试通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

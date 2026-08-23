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
const { execFileSync } = require('child_process');

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
  console.log(`测试目录: ${TEST_DIR}\n`);
  fs.mkdirSync(TEST_DIR, { recursive: true });

  try {
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

    // 5. reset
    const resetRes = run(['reset']);
    assert(resetRes.reset === true && !fs.existsSync(path.join(TEST_DIR, '.408-mentor', 'profile.json')), 'reset 删除画像文件');

    console.log('\n🎉 所有冒烟测试通过');
  } finally {
    cleanup();
  }
}

main();

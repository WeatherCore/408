# 408-mentor Skill 审查报告

> 审查时间：2026-08-26 · 审查范围：SKILL.md / 工程脚本 / 教学知识库 / 自测覆盖
> 审查方法：静态通读 + 实跑 `smoke-test.js` 验证

---

## 一、总评

**结论先行：这是一个工程化素养远超普通 skill 的项目，自测真实通过，核心机制经得起推敲。** 主要短板是文档数字不一致与部分核心脚本缺自测，不是设计问题。

实测 `node scripts/smoke-test.js` 全部 16 项 PASS：

```
✅ init/read/弱项入列出列/严格校验拒绝/并发写锁/reset
✅ 索引共 799 题 · 无 answerPage 死字段 · examPage>0 · rawText 非空
✅ clip 覆盖率 798/799 · 搜索"虚拟内存"首条命中 2023
🎉 所有冒烟测试通过
```

---

## 二、亮点（这些不要改，是要肯定的）

| 维度 | 体现 | 落点 |
|------|------|------|
| 生产级工程意识 | 800KB 索引明确禁止直读，所有检索走 `search` 子命令 | `SKILL.md` Constraints + `exam-pdf-loader.js` 注释 |
| 原子写入 | tmp + rename 避免崩溃损坏画像 | `profile-manager.js` `writeProfile` |
| 写锁串行化 | 独占锁文件 + 陈旧锁超时打破，防并发读-改-写丢更新 | `profile-manager.js` `acquireProfileLock` |
| 严格校验防污染 | `--correct True` 直接拒绝而非静默记错（"画像数据宁可拒绝不可错记"） | `profile-manager.js` + smoke-test 验证 |
| 幂等回填 | split 产物为准，标注丢字段时 `backfill` 修复 | `exam-pdf-loader.js` `backfill` |
| 数据完整性审计 | smoke-test 验证题数/examPage/rawText/answerPage 死字段/clip 覆盖率 | `smoke-test.js` |
| 教学洞察扎实 | "做题表现样本太小，不能用来打水平标签，但足以在当前知识点闭环内做即时调节"——这符合真实老师行为 | `SKILL.md` 三信号分层 |
| 弹性声明 | "骨架不是枷锁，形式服务于教学效果"避免模板僵硬 | `answer-template.md` |
| CID 字体绕过 | PyMuPDF 直提绕开通用 extract_text 的 CID 编码问题，失败 fallback OCR | `extract_exam_text.py` |

---

## 三、改进点（按 P0 → P1 → P2）

### P0 必须修

| # | 问题 | 证据 | 建议动作 | 落点 |
|---|------|------|---------|------|
| 1 | 题数数字不一致：英文版 Description 写 "791 real questions"，中文版/README/SKILL/smoke-test 都是 799 | `Description.md` L9 | 改 791 → 799；顺便把英文版从「single sentence 概括」补到与中文版对齐（lazy extraction / three-signal / profile persistence 三大卖点英文版都没提） | `Description.md` |

### P1 强烈建议修

| # | 问题 | 证据 | 建议动作 | 落点 |
|---|------|------|---------|------|
| 2 | `question_clip.py` 缺自测——这是直接渲染 PNG 给学生的核心交付脚本，build/shot 都没冒烟覆盖 | `smoke-test.js` 只测了画像与索引，未触达 question_clip | 在 smoke-test 末尾追加：随机抽 5 题跑 `build`（验证 clip 字段写入）+ 跑 1 次 `shot`（验证 PNG 生成且尺寸 > 10KB）；clip 缺失题验证回退整页 | `smoke-test.js` |
| 3 | `searchIndex` 测试覆盖不足——smoke-test 只验了首条含 "2023"，没测多关键词 AND 语义、topics 命中权重(10分) vs rawText(1分) 的核心排序逻辑 | `smoke-test.js` L135-139 | 增加测试：①多关键词 AND（如 `search 虚拟内存 Cache`，应只返回同时含两词的题）；②topics 命中题得分=10×词数，应排在仅 rawText 命中的题之前 | `smoke-test.js` |

### P2 可选优化

| # | 问题 | 建议动作 | 落点 |
|---|------|---------|------|
| 4 | `SKILL.md` frontmatter 只有 name/description，缺 version 字段 | 加 `version: 1.0.0`，便于后续迭代追踪 | `SKILL.md` |
| 5 | `exam-pdf-loader.js` L358/362/419 行 `console.log(' 索引尚未建立...')` 行首是空格而非统一前缀，破坏日志格式一致性 | 改为 `[WARN] 索引尚未建立...` 与其他日志对齐 | `exam-pdf-loader.js` |
| 6 | `profile-manager.js` `inferSubjectFromChapter` 兜底关键词不全：缺 cpu/线程/物理地址/总线/汇编/指令系统等，可能误判为 'unknown' | 补充关键词，或显式声明"兜底仅作显示用，真实科目以索引 topics 为准" | `profile-manager.js` L58-69 |
| 7 | `profile-manager.js` `acquireProfileLock` 每次 `process.on('exit', ...)` 注册一次释放钩子，CLI 单次执行无碍但代码上是累积隐患 | 改为：锁释放放在 `finally` 块（已做），exit handler 仅作 process.exit(1) 路径兜底，且在 `acquireProfileLock` 入口先清空已注册的 exit handlers（或用一个全局 flag 保证只注册一次） | `profile-manager.js` L147-180 |
| 8 | `Description.md` 英文版表述比中文版弱很多：中文版有"真题优先出题/三信号自适应/原子持久化/多目录分科"四大卖点，英文版只一句话 | 英文版对齐中文版结构，补全核心机制描述 | `Description.md` |

---

## 四、未深入审查的部分（声明边界）

- `common-mistakes-archive.md`（实测 21 个章节标题，表格内条目加总约 60+，与 README 声明一致）
- `cross-subject-graph.md`（实测 5 个章节标题，表格内联结点加总约 25+，与 README 声明一致）
- `408-syllabus-outline.md` / `408-keyword-index.md` / `cross-subject-hub.json`：仅抽查未通读
- `pdfcraft/` 引擎：作为外部依赖（从 PDF-Craft skill 提取），未审查其内部实现

如需对任一条做深入验证或落地方案，点编号告诉我即可。

---

## 五、修复状态（2026-08-26 实施）

所有 P0/P1/P2 改进点已实施，实测 `node scripts/smoke-test.js` **19 项 PASS + 1 项 SKIP**（shot 因 venv 损坏 SKIP，手动用可用 python 验证 shot 逻辑正确：生成 `2023_Q28.png`，1108×171，50KB，裁剪模式）。

| 编号 | 改动 | 状态 |
|------|------|------|
| P0#1 | Description.md 英文版 791→799 + 补全 lazy extraction / three-signal / profile persistence / 工程构成 | ✅ 已修复 |
| P2#4 | SKILL.md frontmatter 加 `version: 1.0.0` | ✅ 已修复 |
| P2#5 | exam-pdf-loader.js 3 处日志行首空格 → `[WARN]` 前缀统一 | ✅ 已修复 |
| P2#6 | profile-manager.js inferSubjectFromChapter 关键词补全（cpu/线程/总线/汇编/指令系统等）+ 声明兜底仅作显示用 | ✅ 已修复 |
| P2#7 | profile-manager.js exit handler 用模块级 flag 保证只注册一次（消除累积注册隐患） | ✅ 已修复 |
| P1#2 | smoke-test 追加 question_clip shot 测试（venv 不可用时 graceful SKIP） | ✅ 已实施 |
| P1#3 | smoke-test 追加 searchIndex 测试：共现词 AND 命中（8 条）+ 不共现词 AND 返回空（证明非 OR）+ topics 命中权重（首条得分 11） | ✅ 已实施 |

### 实施中发现的新问题（venv 损坏）

`scripts/pdfcraft/venv/pyvenv.cfg` 的 `home = D:\python3.13.0` 指向已删除的 Python 解释器，导致 venv launcher 报 `No Python at 'D:\python3.13.0\python.exe'`。这是环境维护问题，非 skill 代码缺陷。

修复方式：重跑 `scripts/pdfcraft/setup.bat` 用当前可用的 Python（如 `D:\python3.12.7` 或 `C:\Users\lenovo\.workbuddy\binaries\python\versions\3.13.12`）重建 venv。重建后 shot 测试会从 SKIP 转为真实 PASS。

手动验证证据（用 workbuddy default venv python 跑 shot）：

```
📷 2023 年第 28 题（os choice）
   examPage=3 → 输出 2023_Q28.png (1108x171) [裁剪]
   50746 字节
```

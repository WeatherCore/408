# Description

## 中文版

408-mentor 是考研 408 四科的良师型 ZCode Skill，渐进式答疑并即时出题检验。含金量在真题优先出题：倒排索引 exam-index.json 收录 2009-2025 共 799 道真题与 1947 个知识点词条，一次构建运行时只读；命中真题经 question_clip.py 按题号裁剪为单题截图展示、公式图表不失真，官方解析经用户确认才从答案 PDF 懒提取；三信号自适应，做题表现仅在当前知识点闭环内调节、不跨知识点推断水平。画像经 profile-manager.js 原子持久化到工作目录，含审计轨迹与章节统计，多目录天然分科。工程由四个 Node/Python 脚本、五份知识库与 PDF-Craft 引擎构成，适合 408 考生全阶段备考。

## English

408-mentor is a mentor ZCode Skill for China's 408 postgraduate entrance exam (Data Structures / Computer Organization / Operating Systems / Computer Networks): layered answers with per-topic quizzes pulled from a prebuilt inverted index. The index holds 799 real questions (2009-2025) across 1947 knowledge-point entries, built once and read-only at runtime; matched questions render as single-question screenshots (via question_clip.py) so formulas and figures stay intact while neighboring questions stay hidden; official solutions are lazily extracted from answer PDFs only after the student confirms. A three-signal adaptation scheme (user self-declaration sets the level tag, phrasing gently corrects it, in-topic quiz performance tunes teaching locally without cross-topic inference) keeps instruction within the current topic. The learner profile is persisted atomically (temp file + rename, with audit trail and per-chapter stats) to `.408-mentor/profile.json` under the working directory, so separate folders naturally isolate subjects. The project is built from four Node/Python scripts, five knowledge bases, and a PDF-Craft engine — suitable for all stages of 408 prep.

<div align="center">

# 🎓 408-mentor

**不是题库，不是搜题器——是一位记得住你、看得懂你、陪你把 408 啃下来的良师。**

*An AI mentor for China's CS postgraduate entrance exam (408) — adaptive, persistent, cross-subject.*

[![Skill](https://img.shields.io/badge/Skill-408--mentor-D4AF37?style=flat-square)](./SKILL.md)
[![Subjects](https://img.shields.io/badge/Subjects-DS%20%7C%20CO%20%7C%20OS%20%7C%20NET-3776AB?style=flat-square)](./references/408-syllabus-outline.md)
[![Node](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-D4AF37?style=flat-square)](./LICENSE)

[快速开始](#-快速开始) · [设计哲学](#-设计哲学良师不是搜索引擎) · [核心机制](#-核心机制) · [项目结构](#-项目结构) · [技术亮点](#-技术亮点)

</div>

---

## 📖 这是什么

考研 408 统考四科——数据结构、计算机组成原理、操作系统、计算机网络——每一科都厚得像砖头，知识点之间还互相勾连（虚拟内存横跨 OS 和计组，Cache 和页面置换同源）。刷题能查漏，但查完缺的那块"为什么"谁来补？

**408-mentor 作为一个良师 Skill**，当你在对话中提出 408 相关问题时自动触发。它不直接甩答案，而是像一位经验丰富的辅导老师那样：

- 先用一句话让你抓住本质，再分层展开原理
- 每讲完一个点出一道选择题检验，答错就领你走完纠错闭环
- 记住你的水平和做题轨迹，换一个对话窗口也不忘
- 涉及跨科的知识点，主动提示"这里还牵连着哪一科"

> 💡 它做良师，不做搜题器。它讲的是"为什么这样、怎么考、坑在哪"，而不是"选 C 因为 ABCD"。

---

## 🧭 设计哲学：良师不是搜索引擎

一个真正的良师和一个搜索引擎的区别在于三件事：**记得住学生、调得动教法、看得见全局**。408-mentor 的全部设计都围绕这三点展开。

| 设计支柱 | 搜索引擎的做法 | 408-mentor 的做法 |
|---------|--------------|------------------|
| **记得住你** | 每次从零开始 | 跨会话学习画像：水平标签 + 做题记录持久化到 `.408-mentor/profile.json`，下次打开对话不用重新自我介绍 |
| **调得动教法** | 千人一面 | 三信号分层自适应：自声明设标签、措辞做温和修正、做题表现做即时教学调节（换讲法 + 降深度 + 降题难度） |
| **看得见全局** | 孤立知识点 | 跨科知识图谱：虚拟内存讲到一半，主动提示"这里还牵连计组的 TLB"，由你决定是否追问 |

这三支柱不是口号，每一个都落到了具体的文件和脚本上——见下方[核心机制](#-核心机制)。

---

## ⚙️ 核心机制

### 1. 渐进式展开回答结构

每轮回答不是一次性倒完所有内容，而是按层次展开。核心骨架必出，细节层追问才出——避免信息轰炸，尊重学生的认知节奏。

```
🎯 一句话直觉     ← 生活类比，一句话抓住本质（适配水平）        必出
📚 原理深讲       ← 核心概念/机制/数据结构，按水平调深度         必出
├─ 🔬 细节展开    ← 底层/源码级/硬件级                       追问才出
├─ 💻 代码/图示   ← DS 出 C 代码、CO 出 ASCII 图             追问才出
├─ ⚠️ 易错辨析    ← 真实考试中学生的典型误区                  必出
├─ 📝 考点定位    ← 考纲位置 + 考查频率 + 命题角度             必出
└─ ✍️ 来道题试试  ← 选择题优先，四选项逐一解析                 必出
```

模板定义在 `references/answer-template.md`，并附"骨架不是枷锁"声明——形式服务于教学效果。

### 2. 三信号分层自适应

水平判断不是一条腿走路，而是三条信号各司其职：

| 信号 | 作用域 | 用途 | 写入 JSON |
|------|--------|------|-----------|
| ① 用户自声明 | 整体水平标签 | 最高优先级，"第一次接触"→ 初学 | `update-level --reason user_declared` |
| ② 问题措辞推断 | 温和修正标签 | 与当前标签严重不符时上调/下调 | `update-level --reason phrasing_*` |
| ③ 做题表现 | **当前知识点闭环** | 连错 2 题 → 三管齐下（换讲法 + 降深度 + 降题难度） | **不写标签**，仅做局部调节 |

关键洞察：做题表现样本太小，不能用来给用户打"你是初学者"的标签——但足以在**当前这个知识点**的教学闭环内做即时调节。这是真实老师做的事：不会因一道题就重新定义学生，但会因一道错题换个讲法。

### 3. 跨会话学习画像

学习画像通过 `scripts/profile-manager.js` 持久化到当前工作目录的 `.408-mentor/profile.json`：

```mermaid
flowchart LR
    A[会话首次触发] --> B{profile.json 存在?}
    B -- 否 --> C[静默 init + 告知用户]
    B -- 是 --> D[读取 level 作为初始水平]
    C --> E[缓存上下文]
    D --> E
    E --> F[正常答疑 + 出题]
    F --> G{做题完成}
    G --> H[update-question 实时写 JSON]
    G --> I{水平标签变化?}
    I -- 是 --> J[update-level 写 JSON + 审计轨迹]
    I -- 否 --> K[继续]
    J --> K
    H --> K
    K --> L[下次新会话从 JSON 读初始水平]
```

画像结构（`profile-manager.js` 管理，原子写入避免损坏）：

| 字段 | 用途 |
|------|------|
| `level` | 当前水平（beginner / review / sprint），会话初始值 |
| `levelHistory` | 水平变更审计轨迹，记录每次变更原因 |
| `stats` | 做题统计，按章节聚合正确率 |
| `questionLog` | 做题明细日志 |
| `weakTopics` | **预留字段**——未来自动识别薄弱知识点 |

### 4. 跨科知识联动

很多 408 考点是跨科的，强行只讲一科是失职，全跨是灌水。408-mentor 采用**主科详讲 + 关联科拓展链接**策略：

```
[主科视角详细展开]
   ↓
┌─────────────────────────────────────┐
│ 🔗 拓展链接                         │
│ 这也涉及 计算机组成原理              │
│ ❮ 存储系统 - TLB 快表 ❯            │
│ → 想了解 TLB 在硬件层面如何加速？   │
│   可以追问！                        │
└─────────────────────────────────────┘
```

跨科联结点定义在 `references/cross-subject-graph.md`，覆盖 25+ 联结点，含 7 个考研综合题高频跨科套路。

### 5. 纠错四步法 + ⑤ 易错汇总

答错题不是终点，而是教学的起点：

```
① 鼓励      "这个选项很典型，很多同学会选它"
② 指出错因   "选项 B 描述的是分段机制，不是分页机制"
③ 重讲推理   重新梳理正确的推导链条
④ 变式题     同一知识点换角度再出一道
⑤ 易错汇总   关联考试中最常见的 2-3 个踩坑点，提前帮学生避雷
```

---

## 🏗️ 架构总览

```mermaid
flowchart TB
    subgraph 触发层
        U[用户自然语言提问<br/>可选带 ds/co/os/net 标签]
    end

    subgraph 识别层
        KI[408-keyword-index.md<br/>跨科术语去歧义]
        CG[cross-subject-graph.md<br/>跨科联结点检查]
        PM[profile-manager.js<br/>读取学习画像]
    end

    subgraph 教学层
        AT[answer-template.md<br/>渐进式展开模板]
        CM[common-mistakes-archive.md<br/>高频易错点档案]
        SO[408-syllabus-outline.md<br/>考纲锚点]
    end

    subgraph 持久层
        PJ[.408-mentor/profile.json<br/>跨会话学习画像]
    end

    U --> KI
    U --> PM
    KI --> AT
    PM --> AT
    CG --> AT
    AT --> CM
    AT --> SO
    AT -->|做题后| PM
    PM --> PJ
```

---

## ✨ 功能全景

- 🎯 **渐进式答疑** — 一句话直觉 → 原理深讲 → 易错辨析 → 考点定位 → 出题检验，核心骨架必出、细节层追问才出
- 🧬 **三信号自适应** — 自声明设标签 / 措辞做温和修正 / 做题表现做即时教学调节，各司其职不过度承诺
- 💾 **跨会话画像** — 水平标签 + 做题记录持久化，下次对话不用重新自我介绍
- 🗂️ **分科档案隔离** — 开四个工作目录天然分科，数据结构/计组/OS/网络互不干扰
- 🔗 **跨科联动** — 25+ 跨科联结点，虚拟内存讲到一半提示"这里还牵连计组 TLB"
- ✍️ **出题检验** — 每个知识点配一道选择题，四选项逐一解析（为什么对/为什么错）
- 🔄 **纠错闭环** — 四步法 + ⑤ 易错汇总，连错同知识点自动三管齐下（换讲法/降深度/降题难度）
- 📚 **四科特色教法** — DS 出 C 代码、CO 出 ASCII 结构图、OS 用状态机推演、NET 分层递进
- 🇨🇳 **王道风格术语** — 中英混杂（"TLB（Translation Lookaside Buffer，页表缓存）"），与教材无缝衔接
- 📄 **真题预留** — `exam-pdf-loader.js` 已预留接口，后续导入真题 PDF 即可切换真题检索出题

---

## 🚀 快速开始

### 0️⃣ 环境要求

| 组件 | 版本 | 说明 |
|------|------|------|
| ZCode | 任意支持 Skill 的版本 | Skill 运行环境 |
| Node.js | 18+ | `profile-manager.js` 依赖 |

### 1️⃣ 安装

将 `408-mentor` 目录放到 ZCode 的 skills 目录下（通常为 `~/.zcode/skills/`）。

### 2️⃣ 开始使用

直接用自然语言提问，不需要任何命令前缀：

```
讲一下虚拟内存的工作原理
[os] 页面置换算法有哪些？
我第一次接触，完全不懂 Cache 是什么
TCP 和 UDP 的区别
```

首次在某个工作目录使用时，Skill 会自动创建 `.408-mentor/profile.json` 并告知你。

### 3️⃣ 可选：科目标签

Skill 会自动识别问题属于哪个科目。想手动限定视角时，在问题前加标签：

| 标签 | 科目 |
|------|------|
| `[ds]` | 数据结构 |
| `[co]` | 计算机组成原理 |
| `[os]` | 操作系统 |
| `[net]` | 计算机网络 |

### 4️⃣ 水平自适应信号

通过说法让 Skill 知道你的水平：

| 你想表达 | 可以这样说 |
|---------|----------|
| 🟢 零基础 | "第一次接触"、"完全看不懂"、"我是零基础" |
| 🟡 复习中 | "之前学过但忘了"、"帮忙梳理一下" |
| 🔴 冲刺中 | "考点是什么"、"高频命题角度"、"来道难题" |

### 5️⃣ 画像管理

| 操作 | 说法 |
|------|------|
| 重置话题 | "弄明白了"、"谢谢"、"换话题"、"下一个" |
| 清除学习记录 | "重置画像"、"清除我的学习记录" |

<details>
<summary><b>📁 进阶用法：分科档案（点击展开）</b></summary>

408 通常是"学完一门再下一门"。Skill 把画像存到当前工作目录的 `.408-mentor/profile.json`。**为四科各开一个工作目录**，就能天然隔离每科的画像和做题记录：

```
考研复习/
├── 数据结构/      ← 在这里问 DS 问题，画像记录 DS 进度
├── 计组/          ← 在这里问 CO 问题，画像记录 CO 进度
├── 操作系统/      ← 在这里问 OS 问题，画像记录 OS 进度
└── 网络/          ← 在这里问 NET 问题，画像记录 NET 进度
```

每个目录的画像独立：水平标签、做题统计、未来扩展的薄弱点追踪都互不干扰。

**`.gitignore` 提醒：** 如果工作目录是 git 仓库，记得把 `.408-mentor/` 加入 `.gitignore`。

</details>

<details>
<summary><b>🔧 profile-manager.js 命令参考（点击展开）</b></summary>

| 命令 | 用途 |
|------|------|
| `node scripts/profile-manager.js read` | 读取画像（不存在返回 null） |
| `node scripts/profile-manager.js init --subject <ds\|co\|os\|net> --level <beginner\|review\|sprint>` | 初始化空画像 |
| `node scripts/profile-manager.js update-question --chapter <章节> --topic <主题> --correct <true\|false> --difficulty <easy\|medium\|hard>` | 追加做题记录并更新统计 |
| `node scripts/profile-manager.js update-level --level <beginner\|review\|sprint> --reason <user_declared\|phrasing_escalation\|phrasing_downgrade>` | 更新水平标签（写审计轨迹） |
| `node scripts/profile-manager.js reset` | 清空画像（删除文件） |

</details>

---

## 📁 项目结构

```
408-mentor/
├── SKILL.md                         ← 核心定义（触发规则、工作流、决策树、约束）
├── README.md                        ← 本文件
├── Description.md                   ← 中英双版项目名片
│
├── references/                      ← 教学知识库
│   ├── 408-syllabus-outline.md      ← 四科完整考纲大纲（162 行）
│   ├── 408-keyword-index.md         ← 术语→科目映射表（200+ 术语，聚焦跨科去歧义）
│   ├── cross-subject-graph.md       ← 跨科知识联结点图谱（25+ 联结点）
│   ├── common-mistakes-archive.md   ← 四科高频易错点档案（60+ 易错点）
│   └── answer-template.md           ← 渐进式回答模板 + 水平适配规则
│
├── scripts/                         ← 工具脚本
│   ├── profile-manager.js           ← 学习画像 JSON 读写（read/init/update/reset）
│   ├── build-keyword-index.js       ← 术语索引构建/覆盖率检查
│   └── exam-pdf-loader.js           ← 真题 PDF 解析器（预留，等资料到位激活）
│
└── examples/
    └── example-dialogs.md           ← 5 个完整对话示例（覆盖三水平 × 四科目）
```

> 逐文件深度导读见各文件内部注释，核心设计逻辑见 [SKILL.md](SKILL.md)。

---

## 💡 技术亮点

| 亮点 | 机制 | 落点文件 |
|------|------|---------|
| **三信号分层自适应** | 自声明设标签 / 措辞温和修正 / 做题表现局部调节，不做跨知识点水平推断 | `SKILL.md` Decision Tree |
| **跨会话画像持久化** | 原子写入（临时文件 + rename）+ 审计轨迹 + 章节级做题统计 | `scripts/profile-manager.js` |
| **分科档案隔离** | 工作目录即画像边界，用户开四个目录天然分科，零配置 | `.408-mentor/profile.json` |
| **渐进式展开** | 核心骨架必出 + 细节层追问才出，配"骨架不是枷锁"弹性声明 | `references/answer-template.md` |
| **跨科去歧义索引** | 200+ 术语表，仅在跨科歧义时强制查表，单科术语 LLM 直接判断 | `references/408-keyword-index.md` |
| **纠错四步法 + ⑤** | 鼓励 → 指错 → 重讲 → 变式 → 易错汇总，连错自动三管齐下 | `SKILL.md` + `references/common-mistakes-archive.md` |
| **四科特色教法** | DS→C 代码、CO→ASCII 图、OS→状态机、NET→协议流，一科一风格 | `SKILL.md` 四科专属教学特色表 |

---

## 🗺️ Roadmap

- [x] 渐进式展开回答结构
- [x] 三信号分层自适应
- [x] 跨会话学习画像（水平标签 + 做题记录持久化）
- [x] 分科档案隔离（工作目录天然分科）
- [x] 跨科知识联动
- [x] 纠错四步法 + ⑤ 易错汇总
- [ ] 导入历年真题 PDF → 出题时优先从真题库检索
- [ ] 结构化教学功能迭代（识别知识点后给出该章节完整知识图谱）
- [ ] 薄弱知识点自动识别（基于做题记录的章节正确率分析，扩展 JSON 的 `weakTopics` 字段）

---

## 🤝 贡献

欢迎 Fork → Branch → PR。特别欢迎以下贡献：

- 📝 补充 `common-mistakes-archive.md` 中的真实易错点（你踩过的坑就是下一个学生的避雷针）
- 🔗 扩展 `cross-subject-graph.md` 的跨科联结点
- 📄 提供历年真题 PDF 用于 `exam-pdf-loader.js` 的对接测试

---

## 📄 License

MIT

---

<div align="center">

**如果这个 Skill 帮到了你，给个 ⭐ 让更多考研人看到。**

*愿每一位 408 考生都能遇见自己的良师。*

</div>
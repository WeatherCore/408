# 工作流细则（低频路径按需查阅）

> 本文件承载 SKILL.md 下沉的低频操作规程。高频路径（出题、纠错、画像读写）以 SKILL.md 为准。
> 触发词索引：**索引重建** / **扫描年答案** / **解析正文提取** / **答案表维护** / **PDF 环境初始化**。

---

## 1. 官方答案与解析提取（详细规程）

### 1.1 选择题官方答案 — 查表优先

`references/exam-archive/answers.json` 结构：

```jsonc
{
  "version": "1",
  "years": {
    "2012": {
      "scanned": false,
      "choiceAnswers": { "1": "B", "2": "A", "...": "（1-40 全）" },
      "comprehensivePages": { "41": 4, "42": 5, "...": "（答案起始页，1 基）" },
      "source": "visual",        // 视觉核验过的年份为 visual（文本解析结果已被覆盖）
      "verified": true
    }
  },
  "verification": { "verifiedAt": "2026-11-16", "method": "...", "coverage": "17/17 年 × 40 题" }
}
```

**读取方式：** 该文件约 30KB，可用 `node -e "console.log(JSON.parse(require('fs').readFileSync('references/exam-archive/answers.json','utf8')).years['2012'].choiceAnswers)"` 单年取值，避免整文件灌上下文；或直接 Read（会占用少量上下文，单次可接受）。

**回退路径（表中缺该题时）：**
```
python scripts/pdfcraft/pdfcraft.py to_images --input data/answers/<子目录>/<年份>-answer.pdf --output_dir <临时目录> --pages "[0]" --dpi 200
```
渲染答案首页视觉读取第 N 题答案字母，并与自己掌握的答案交叉核对，冲突以图为准，向用户说明来源。

### 1.2 官方解析正文（用户想看"为什么"）

- **有文本层年份（2019/2021/2024/2025 之外全部）：**
  ```
  python scripts/pdfcraft/pdfcraft.py chat_pdf --input data/answers/<子目录>/<年份>-answer.pdf --question "<题干关键词>"
  ```
- **扫描件年份（2019/2021/2024/2025）：** OCR 文本（`extracted-text/<年份>-answer.txt`）答案表乱码严重、代码段失真，**禁止当解析来源**。综合题：
  1. 先查 `answers.json` 的 `years.<年>.comprehensivePages` 得到题号→起始页 N（预定位，1 基）
  2. `python scripts/pdfcraft/pdfcraft.py to_images --input <答案PDF> --output_dir <临时目录> --pages "[N-1]" --dpi 200`（**--pages 是 0 基**）
  3. 页码缺失时：在 OCR 文本里按题号/【答案要点】配合页标记 `=== 第 N 页 ===` 定位候选页，多渲染 1-2 页

---

## 2. 真题索引重建（更换/新增 PDF 后）

| 步骤 | 命令 | 说明 |
|------|------|------|
| 1 | `node scripts/exam-pdf-loader.js extract-all` | 批处理所有年份 PDF 文本提取 |
| 2 | `node scripts/exam-pdf-loader.js split <年份>` | 按题号分割指定年份文本 |
| 3 | LLM 逐题标注知识点 | 标注结果写入 `exam-index.json` |
| 4 | `node scripts/exam-pdf-loader.js backfill --force` | 将 split 产物的 examPage/rawText 幂等回填进索引 |
| 5 | `python scripts/question_clip.py build` | 预计算每题裁剪框存入索引 clip 字段 |
| 查询 | `node scripts/exam-pdf-loader.js search [--or] [--syn] <关键词>` | 运行时检索入口 |
| 统计 | `node scripts/exam-pdf-loader.js stats` | 题库统计（文档引用数字一律以此为准） |

- 文本提取由 `scripts/extract_exam_text.py` 完成（PyMuPDF 直提绕过 CID 字体编码，失败 fallback OCR；OCR 依赖 pytesseract + 系统 Tesseract + chi_sim 语言包，未安装时 WARN 降级）
- `extract-all` 遇无文本层扫描版 PDF 会报错并提示改走 `python scripts/extract_exam_text.py`（OCR 路径）
- 索引字段缺失时先跑 `backfill` 修复
- `answers_builder.js`（构建官方答案表，`--check` 校验）与 `merge-visual-answers.js`（视觉核验合并）仅在答案数据维护时使用

---

## 3. PDF 处理环境初始化

```
cd 408-mentor/scripts/pdfcraft
setup.bat
```

- 探测 Python 3.10+（找不到自动从 GitHub 下载 3.13）；venv 已存在但 `import fitz` 失败时自动删除重建
- 装 requirements.txt（`--all` 才装 optional）；下载 NotoSansSC 字体（带魔数校验）
- `question_clip.py` / `pdfcraft.py` 会自动注入 venv site-packages（版本守卫：venv 与当前解释器版本一致才注入），无需手动激活

---

## 4. 文档统计数字约定

README/SKILL.md 中的 799 题 / 1947 词条 / 798 clip 等数字是**发布时快照**。新增年份后以 `node scripts/exam-pdf-loader.js stats` 实际输出为准，勿照抄旧数字。

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
question_clip.py — 408-mentor 真题单题裁剪截图工具

用法：
  python scripts/question_clip.py build                          # 为索引中所有题生成裁剪框并写回 index
  python scripts/question_clip.py shot <年> <题号> <输出目录>      # 裁剪渲染单题为 PNG

设计说明：
- build：基于 examPage 和题号定位，使用 PyMuPDF 逐页检测题号线、页脚线，
  输出 [x0, y0, x1, y1] 到索引的 clip 字段。clip 缺失时 shot 回退到整页。
- shot：读取索引中 clip，按 150dpi 渲染 PNG；clip 不存在时回退到整页截图。
- 顺带清理未启用的 answerPage 占位字段。
"""

import json
import os
import re
import sys

# 激活 pdfcraft venv（镜像 pdfcraft.py 的引导逻辑）
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_VENV_DIR = os.path.join(_SCRIPT_DIR, "pdfcraft", "venv")
if os.path.isdir(_VENV_DIR):
    _pyvenv_cfg = os.path.join(_VENV_DIR, "pyvenv.cfg")
    _venv_version = None
    if os.path.isfile(_pyvenv_cfg):
        try:
            with open(_pyvenv_cfg, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if line.startswith("version"):
                        _venv_version = line.split("=", 1)[1].strip()
                        break
        except OSError:
            pass
    _running_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    if _venv_version and not _venv_version.startswith(_running_version):
        _venv_python = os.path.join(_VENV_DIR, "Scripts", "python.exe")
        if not os.path.isfile(_venv_python):
            _venv_python = os.path.join(_VENV_DIR, "bin", "python")
        print(
            f"[WARN] venv 是 Python {_venv_version}，当前解释器 {_running_version}，跳过 venv 注入；"
            f"建议用 {_venv_python} 运行",
            file=sys.stderr,
        )
    else:
        _sp_win = os.path.join(_VENV_DIR, "Lib", "site-packages")
        if os.path.isdir(_sp_win) and _sp_win not in sys.path:
            sys.path.insert(0, _sp_win)

try:
    import fitz  # PyMuPDF
except ImportError:
    print("[ERROR] 需要 PyMuPDF: pip install pymupdf")
    sys.exit(1)

ROOT = os.path.dirname(_SCRIPT_DIR)
INDEX_PATH = os.path.join(ROOT, "references", "exam-archive", "exam-index.json")
EXAMS_DIR = os.path.join(ROOT, "data", "exams")
DEFAULT_DPI = 150
PAD_TOP = 6
PAD_BOTTOM = 6
PAD_LEFT = 8
PAD_RIGHT = 36
LEFT_MARGIN_THRESHOLD = 60  # pt，题号行通常靠近左页边（约 40pt）


def subdir_for_year(year):
    return "2010-2019" if year <= 2019 else "2020-2025"


def get_page_lines(page):
    """按从上到下、从左到右排序的行列表，每项 (text, bbox)"""
    d = page.get_text("dict")
    lines = []
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            bbox = line.get("bbox")
            lines.append((text.strip(), bbox))
    lines.sort(key=lambda t: (round(t[1][1], 1), t[1][0]))
    return lines


def find_question_start(lines, number, page_width):
    """在行列表中定位题号行，返回 (bbox, index)；未找到返回 (None, -1)"""
    # 408 真题格式示例："25. 下列关于..." 或 "41.（10 分）"
    # 兼容全角点 / 英文点 / 顿号
    num_re = re.compile(rf"^\s*{number}\s*[\.．\、]?\s*")
    candidates = []
    for i, (text, bbox) in enumerate(lines):
        if num_re.match(text):
            if bbox[0] < page_width * 0.2:  # 题号行一般在左半边，且不靠右
                candidates.append((bbox, i))
    # 优先取最靠近左上角的
    if candidates:
        candidates.sort(key=lambda c: (c[0][1], c[0][0]))
        return candidates[0]
    return None, -1


def footer_y(lines, page_height, year):
    """返回页脚 y 坐标（底部以上区域保留到此处为止）。"""
    # 408 真题页脚模式示例：
    # "2012 年全国硕士研究生入学统一考试计算机科学与技术学科联考计算机学科专业基础综合试题 第 3 页（共 11 页）"
    footer_re = re.compile(r"第\s*\d+\s*页\s*[（(]共\s*\d+\s*页")
    for text, bbox in reversed(lines):
        if footer_re.search(text):
            return bbox[1]  # bbox bottom
    # 兜底：距底边 36pt
    return page_height - 36


def compute_clip(year, number, exam_page):
    """返回 (clip_rect, reason)。clip_rect 为 fitz.Rect 或 None；reason 说明来源/回退原因。"""
    pdf_path = os.path.join(EXAMS_DIR, subdir_for_year(year), f"{year}.pdf")
    if not os.path.exists(pdf_path):
        return None, "PDF 缺失"

    try:
        doc = fitz.open(pdf_path)
        if exam_page < 1 or exam_page > doc.page_count:
            doc.close()
            return None, "页码越界"

        page = doc[exam_page - 1]
        lines = get_page_lines(page)
        page_width = page.rect.width
        page_height = page.rect.height

        start_bbox, _ = find_question_start(lines, number, page_width)
        if start_bbox is None:
            doc.close()
            return None, "题号行未定位"

        # 页脚
        f_y = footer_y(lines, page_height, year)

        # 下一题：在同页查找大于当前题号的行
        next_bbox, _ = None, -1
        for text2, bbox2 in lines:
            m = re.match(r"^\s*(\d{1,2})\s*[\.．\、]?\s*", text2)
            if m:
                nxt = int(m.group(1))
                if nxt > number and nxt <= 47 and bbox2[1] > start_bbox[1]:
                    next_bbox = bbox2
                    break

        y0 = max(0, start_bbox[1] - PAD_TOP)
        if next_bbox:
            y1 = next_bbox[1] - PAD_BOTTOM
        else:
            y1 = f_y - PAD_BOTTOM

        x0 = max(0, start_bbox[0] - PAD_LEFT)
        x1 = min(page_width, page_width - PAD_RIGHT)

        # 安全边界
        y1 = min(y1, page_height - 24)
        if y1 <= y0:
            doc.close()
            return None, "裁剪高度异常"

        doc.close()
        return fitz.Rect(x0, y0, x1, y1), "OK"
    except Exception as e:
        return None, f"异常: {e}"


def build_clips():
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        index = json.load(f)

    questions = index.get("questions", [])
    total = len(questions)
    ok_count = 0
    fallback_count = 0
    per_year = {}

    for q in questions:
        year = q["year"]
        number = q["number"]
        exam_page = q.get("examPage", 0)
        if not exam_page:
            q["clip"] = None
            fallback_count += 1
            per_year[year] = per_year.get(year, {"ok": 0, "fail": 0})
            per_year[year]["fail"] += 1
            continue

        rect, reason = compute_clip(year, number, exam_page)
        if rect:
            q["clip"] = [round(rect.x0, 1), round(rect.y0, 1), round(rect.x1, 1), round(rect.y1, 1)]
            ok_count += 1
        else:
            q["clip"] = None
            fallback_count += 1

        per_year.setdefault(year, {"ok": 0, "fail": 0})
        if rect:
            per_year[year]["ok"] += 1
        else:
            per_year[year]["fail"] += 1

        # 清理未启用的 answerPage 占位字段
        if "answerPage" in q:
            del q["answerPage"]

    # 同样清理顶层可能残留的 answerPage 相关元数据（如有）
    if "answerPage" in index:
        del index["answerPage"]

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(f"\n✂️ 裁剪框构建完成：共 {total} 题，命中 {ok_count} 题，回退 {fallback_count} 题")
    print("\n按年份统计：")
    for y in sorted(per_year.keys()):
        s = per_year[y]
        print(f"  {y}: 命中 {s['ok']} / 回退 {s['fail']}")


def shot_question(year, number, output_dir, dpi=DEFAULT_DPI):
    if not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        index = json.load(f)

    questions = index.get("questions", [])
    q = next((x for x in questions if x["year"] == year and x["number"] == number), None)
    if not q:
        print(f"[ERROR] 未找到 {year} 年第 {number} 题")
        sys.exit(1)

    exam_page = q.get("examPage", 0)
    clip = q.get("clip")
    pdf_path = os.path.join(EXAMS_DIR, subdir_for_year(year), f"{year}.pdf")
    if not os.path.exists(pdf_path):
        print(f"[ERROR] PDF 缺失：{pdf_path}")
        sys.exit(1)

    doc = fitz.open(pdf_path)
    if exam_page < 1 or exam_page > doc.page_count:
        print(f"[ERROR] 页码越界：{exam_page}")
        sys.exit(1)

    page = doc[exam_page - 1]
    mat = fitz.Matrix(dpi / 72, dpi / 72)

    if clip:
        rect = fitz.Rect(clip)
        pix = page.get_pixmap(matrix=mat, clip=rect)
        note = "裁剪"
    else:
        pix = page.get_pixmap(matrix=mat)
        rect = page.rect
        note = "整页（clip 缺失）"

    out_name = f"{year}_Q{number}.png"
    out_path = os.path.join(output_dir, out_name)
    pix.save(out_path)
    doc.close()

    print(f"\n📷 {year} 年第 {number} 题（{q.get('subject','?')} {q.get('type','?')}）")
    print(f"   examPage={exam_page} → 输出 {out_name} ({pix.width}x{pix.height}) [{note}]")
    print(f"   {out_path}")
    return out_path


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    cmd = args[0]
    if cmd == "build":
        build_clips()
    elif cmd == "shot":
        if len(args) < 4:
            print("用法：python scripts/question_clip.py shot <年> <题号> <输出目录>")
            sys.exit(1)
        shot_question(int(args[1]), int(args[2]), args[3])
    else:
        print(f"[ERROR] 未知命令：{cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()

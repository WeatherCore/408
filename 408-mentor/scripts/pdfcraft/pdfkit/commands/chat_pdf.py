#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF 问答（Chat with PDF）脚本。

提取 PDF 文本内容，按页分块，返回结构化的上下文信息，
供 AI 进行自然语言问答。

无文本层的扫描版 PDF 可通过 --text_fallback 指定 OCR 文本文件
（按 "=== 第 N 页 ===" 标记分页，如 exam-archive/extracted-text/ 下的产物）。

依赖：PyMuPDF (fitz)
"""

import os
import re

COMMAND = "chat_pdf"
DESCRIPTION = "从 PDF 中提取与问题相关的上下文，供 AI 问答"
CATEGORY = "read"
PARAMS = [
    {"name": "input", "type": "str", "required": True, "help": "PDF 文件路径"},
    {"name": "question", "type": "str", "required": False, "default": "", "help": "用户问题"},
    {"name": "pages", "type": "json", "required": False, "help": "指定页码列表（从 0 开始），默认全部页"},
    {"name": "max_context_chars", "type": "int", "required": False, "default": 8000, "help": "最大上下文字符数"},
    {"name": "text_fallback", "type": "str", "required": False,
     "help": "PDF 无文本层（扫描件）时使用的 OCR 文本文件路径（按 '=== 第 N 页 ===' 分页）"},
]

# OCR 文本（extracted-text/ 产物）的分页标记，如 "\n=== 第 3 页 ===\n"
_PAGE_MARK = re.compile(r"===\s*第\s*(\d+)\s*页\s*===")
# 中文连续片段（用于生成 2-gram，弥补中文无空格分词）
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")


def _tokenize_question(question):
    """切分查询词并生成中文 2-gram。

    空白/标点分词对带空格的多关键词有效；中文查询（如"虚拟内存和页表"）
    无空格可切，整句成一个 token 后 count 基本为 0，因此对中文片段
    额外生成字符 2-gram 参与计分（零依赖，不引入分词库）。
    """
    tokens = [t for t in re.split(
        r"[\s,，、;；。．？?！!·|/\\()\[\]{}\"'“”‘’<>《》:：]+",
        question.lower(),
    ) if t]
    grams = []
    for run in _CJK_RUN.findall(" ".join(tokens)):
        grams.extend(run[i:i + 2] for i in range(len(run) - 1))
    return tokens, grams


def _load_text_fallback(path, pages=None):
    """读取 OCR 文本并按 '=== 第 N 页 ===' 标记分页。

    标记页码为 1 基，转换为与 PDF 一致的 0 基索引返回。
    无标记时整文件作为单页（索引 0）。
    """
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    if not content.strip():
        raise ValueError(f"文本回退文件为空: {path}")

    marks = list(_PAGE_MARK.finditer(content))
    if not marks:
        return [{"page": 0, "text": content.strip(),
                 "char_count": len(content.strip())}]

    result = []
    for i, m in enumerate(marks):
        start = m.end()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(content)
        text = content[start:end].strip()
        if not text:
            continue
        page_idx = int(m.group(1)) - 1  # 标记 1 基 → 0 基
        if pages is not None and page_idx not in pages:
            continue
        result.append({"page": page_idx, "text": text, "char_count": len(text)})
    return result


def handler(params):
    """从 PDF 中提取与问题相关的上下文。

    Args:
        params: {
            "input": PDF 文件路径,
            "question": 用户问题,
            "pages": 指定页码列表（从 0 开始），None 表示全部页,
            "max_context_chars": 最大上下文字符数,
            "text_fallback": 无文本层 PDF 的 OCR 文本路径（可选）,
        }
    """
    import fitz

    input_path = params["input"]
    question = params.get("question", "")
    pages = params.get("pages", None)
    max_context_chars = params.get("max_context_chars", 8000)
    fallback_path = params.get("text_fallback")

    if not os.path.exists(input_path):
        raise FileNotFoundError(f"文件不存在: {input_path}")

    doc = fitz.open(input_path)
    total_pages = len(doc)

    if pages is None:
        pages = list(range(total_pages))

    # 提取每页文本
    page_texts = []
    for p_idx in pages:
        if p_idx < 0 or p_idx >= total_pages:
            continue
        page = doc[p_idx]
        text = page.get_text("text").strip()
        if text:
            page_texts.append({
                "page": p_idx,
                "text": text,
                "char_count": len(text)
            })
    doc.close()

    # 全 PDF 无文本层（扫描件）：走文本回退或明确报错
    source = "pdf"
    fallback_file = None
    if total_pages > 0 and not page_texts:
        if not fallback_path:
            raise ValueError(
                f"PDF 无文本层（{total_pages} 页均为扫描图像），无法提取文本。"
                "可用 --text_fallback <OCR文本路径> 指定回退文本"
                "（如 references/exam-archive/extracted-text/<年份>-answer.txt），"
                "或先用 scripts/extract_exam_text.py 做 OCR 提取。"
            )
        if not os.path.exists(fallback_path):
            raise FileNotFoundError(
                f"PDF 无文本层，且回退文件不存在: {fallback_path}"
            )
        page_texts = _load_text_fallback(fallback_path, pages)
        source = "text_fallback"
        fallback_file = fallback_path

    # 如果有问题关键词，按相关性排序（全词 x2 + 中文 2-gram x0.5）
    if question:
        tokens, grams = _tokenize_question(question)
        for pt in page_texts:
            text_lower = pt["text"].lower()
            score = 2 * sum(text_lower.count(t) for t in tokens)
            score += 0.5 * sum(text_lower.count(g) for g in grams)
            pt["relevance_score"] = score

        # 按相关性排序
        page_texts.sort(key=lambda x: x.get("relevance_score", 0), reverse=True)

    # 截取上下文
    context_parts = []
    total_chars = 0
    for pt in page_texts:
        if total_chars + pt["char_count"] > max_context_chars:
            # 截取部分文本
            remaining = max_context_chars - total_chars
            if remaining > 100:
                context_parts.append({
                    "page": pt["page"],
                    "text": pt["text"][:remaining] + "...(截断)",
                    "truncated": True
                })
            break
        context_parts.append({
            "page": pt["page"],
            "text": pt["text"],
            "truncated": False
        })
        total_chars += pt["char_count"]

    # 按页码重新排序
    context_parts.sort(key=lambda x: x["page"])

    result = {
        "success": True,
        "source": source,
        "total_pages": total_pages,
        "pages_extracted": len(context_parts),
        "total_chars": total_chars,
        "question": question,
        "context": context_parts,
        "metadata": {
            "file": os.path.basename(input_path),
            "file_size": os.path.getsize(input_path)
        }
    }
    if fallback_file:
        result["fallback_file"] = fallback_file
    return result


if __name__ == "__main__":
    from pdfkit.base import main
    main(handler, PARAMS, DESCRIPTION)

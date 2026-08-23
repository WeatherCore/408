#!/usr/bin/env python3
"""
extract_exam_text.py

408 真题 PDF 文本提取器。处理 CID 字体编码问题，fallback 到 OCR。
直接使用 PyMuPDF + pytesseract，不依赖 PDF-Craft 的 extract_text（它的 CID 处理有问题）。

用法：
  python scripts/extract_exam_text.py data/exams/2020-2025/2024.pdf
  python scripts/extract_exam_text.py --all     # 批处理所有真题
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMS_DIR = ROOT / "data" / "exams"
ANSWERS_DIR = ROOT / "data" / "answers"
TEXT_DIR = ROOT / "references" / "exam-archive" / "extracted-text"

# 尝试导入依赖
try:
    import fitz  # PyMuPDF
except ImportError:
    print("[ERROR] 需要安装 PyMuPDF: pip install pymupdf")
    sys.exit(1)

try:
    import pytesseract
    from PIL import Image
    import io
    HAS_OCR = True
except ImportError:
    HAS_OCR = False
    print("[WARN] pytesseract 未安装，OCR fallback 不可用")


def extract_text_pymupdf(pdf_path, page_num):
    """用 PyMuPDF 直接提取文本，尝试多种编码策略"""
    doc = fitz.open(pdf_path)
    if page_num >= len(doc):
        doc.close()
        return ""
    
    page = doc[page_num]
    
    # 策略1：直接提取
    text = page.get_text("text")
    if text and len(text.strip()) > 50:
        doc.close()
        return text
    
    # 策略2：dict 模式提取（更底层的文本块）
    blocks = page.get_text("dict")["blocks"]
    text_parts = []
    for block in blocks:
        if block.get("type") == 0:  # 文本块
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text_parts.append(span.get("text", ""))
    
    text = "".join(text_parts)
    if text and len(text.strip()) > 50:
        doc.close()
        return text
    
    # 策略3：rawdict 模式
    try:
        raw = page.get_text("rawdict")
        text_parts = []
        for block in raw.get("blocks", []):
            if block.get("type") == 0:
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        text_parts.append(span.get("text", ""))
        text = "".join(text_parts)
    except:
        pass
    
    doc.close()
    return text


def ocr_page(pdf_path, page_num, dpi=300):
    """OCR 识别单个页面（300dpi：对中文正文的术语识别明显好于 200，如"逻辑"不再误识为"允辑"）"""
    if not HAS_OCR:
        return ""
    
    doc = fitz.open(pdf_path)
    page = doc[page_num]
    
    # 渲染为高质量图片
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat)
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    
    # OCR
    text = pytesseract.image_to_string(img, lang="chi_sim")
    doc.close()
    return text


def extract_pdf(pdf_path, output_path=None, use_ocr_fallback=True):
    """提取完整 PDF 的文本"""
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    doc.close()
    
    all_text = []
    ocr_used = False
    
    for page_num in range(total_pages):
        text = extract_text_pymupdf(pdf_path, page_num)
        
        if not text or len(text.strip()) < 50:
            if use_ocr_fallback and HAS_OCR:
                print(f"  第 {page_num + 1} 页：文本提取失败，使用 OCR...")
                text = ocr_page(pdf_path, page_num)
                ocr_used = True
            else:
                print(f"  第 {page_num + 1} 页：文本提取失败，跳过")
                text = ""
        
        all_text.append(f"\n=== 第 {page_num + 1} 页 ===\n{text}")
    
    full_text = "\n".join(all_text)
    
    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(full_text, encoding="utf-8")
        print(f"  → 已保存到 {output_path}")
    
    return full_text, ocr_used


def get_all_pdfs():
    """获取所有真题和答案 PDF 列表"""
    pdfs = []
    for subdir in ["2010-2019", "2020-2025"]:
        for data_dir, ptype in [(EXAMS_DIR, "exam"), (ANSWERS_DIR, "answer")]:
            d = data_dir / subdir
            if not d.exists():
                continue
            for f in sorted(d.glob("*.pdf")):
                year_match = f.stem.replace("-answer", "")
                try:
                    year = int(year_match)
                except ValueError:
                    continue
                pdfs.append({
                    "year": year,
                    "type": ptype,
                    "path": str(f),
                    "output": str(TEXT_DIR / f"{year}-{ptype}.txt"),
                })
    return sorted(pdfs, key=lambda x: (x["year"], x["type"]))


def main():
    if len(sys.argv) < 2:
        print("用法：")
        print("  python scripts/extract_exam_text.py <pdf路径>")
        print("  python scripts/extract_exam_text.py --all")
        print("  python scripts/extract_exam_text.py --list")
        sys.exit(1)
    
    arg = sys.argv[1]
    
    if arg == "--all":
        pdfs = get_all_pdfs()
        print(f"\n📚 批处理 {len(pdfs)} 个 PDF...\n")
        success = 0
        ocr_count = 0
        for i, pdf in enumerate(pdfs):
            print(f"[{i+1}/{len(pdfs)}] {pdf['year']}-{pdf['type']}")
            try:
                _, used_ocr = extract_pdf(pdf["path"], pdf["output"])
                success += 1
                if used_ocr:
                    ocr_count += 1
            except Exception as e:
                print(f"  ❌ 失败：{e}")
        print(f"\n✅ 完成：{success}/{len(pdfs)} 成功，{ocr_count} 个使用了 OCR")
    
    elif arg == "--list":
        if TEXT_DIR.exists():
            files = list(TEXT_DIR.glob("*.txt"))
            print(f"\n📚 已提取 {len(files)} 个文本：")
            for f in sorted(files):
                size = f.stat().st_size
                print(f"  {f.name} ({size:,} bytes)")
        else:
            print("📭 尚未提取任何文本")
    
    else:
        pdf_path = sys.argv[1]
        if not os.path.exists(pdf_path):
            print(f"[ERROR] 文件不存在：{pdf_path}")
            sys.exit(1)
        text, _ = extract_pdf(pdf_path)
        print(text[:5000])


if __name__ == "__main__":
    main()
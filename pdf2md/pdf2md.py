#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF2MD — 使用 MinerU CPU 管线将 PDF 批量转换为 Markdown

功能:
  * 输入一个或多个 PDF 文件(也支持包含 PDF 的目录)
  * 调用 MinerU 本地 CPU 管线(pipeline backend)进行解析
  * 转换完成后自动清理中间产物(垃圾文件)
  * 将所有 .md 文档(连同图片资源)交付到用户指定的文件夹

用法:
  python pdf2md.py paper1.pdf paper2.pdf -o D:\md_output
  python pdf2md.py -i "C:\docs\a.pdf" "D:\b.pdf" -o out
  python pdf2md.py                    # 不带参数时进入交互模式
"""

import argparse
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

# Windows 控制台输出 UTF-8，避免中文乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

IMAGE_SRC_DIR = "images"  # MinerU 输出中的图片目录名

# 强制 CPU 管线：必须在导入 mineru 之前设置
os.environ["MINERU_DEVICE_MODE"] = "cpu"


# ---------------------------------------------------------------- 输入收集
def expand_pdf_inputs(raw_paths: list[str]) -> list[Path]:
    """把传入的路径展开成具体 PDF 文件列表(目录则递归扫描 .pdf)。"""
    pdfs: list[Path] = []
    for raw in raw_paths:
        raw = raw.strip().strip('"').strip("'")
        if not raw:
            continue
        p = Path(raw)
        if not p.exists():
            print(f"  [跳过] 路径不存在: {p}")
            continue
        if p.is_dir():
            found = sorted(p.rglob("*.pdf"))
            if not found:
                print(f"  [提示] 目录中未找到 PDF: {p}")
            pdfs.extend(found)
        elif p.suffix.lower() == ".pdf":
            pdfs.append(p)
        else:
            print(f"  [跳过] 非 PDF 文件: {p}")
    # 去重并保持顺序
    seen: set[str] = set()
    unique: list[Path] = []
    for p in pdfs:
        key = str(p.resolve())
        if key not in seen:
            seen.add(key)
            unique.append(p)
    return unique


def interactive_collect() -> tuple[list[Path], Path]:
    """交互模式: 收集 PDF 路径与输出目录。"""
    print("=" * 60)
    print("PDF2MD - MinerU CPU 管线批量转 Markdown")
    print("=" * 60)
    print("请逐个输入 PDF 文件路径(支持直接拖拽文件到窗口)，")
    print("每行一个，输入完成后直接回车(空行)结束：")
    raw: list[str] = []
    while True:
        try:
            line = input("PDF 路径> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not line:
            break
        raw.append(line)
    pdfs = expand_pdf_inputs(raw)
    if not pdfs:
        print("[错误] 未获取到有效的 PDF 文件，程序退出。")
        sys.exit(1)
    print()
    out_raw = input("输出文件夹(存放 md 的目录)> ").strip().strip('"').strip("'")
    if not out_raw:
        print("[错误] 未指定输出文件夹，程序退出。")
        sys.exit(1)
    return pdfs, Path(out_raw)


# ---------------------------------------------------------------- MinerU 转换
def has_text_layer(pdf: Path) -> bool:
    """检测 PDF 是否含有可提取的文本层(扫描件通常没有)。"""
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(pdf))
        for page in reader.pages:
            text = page.extract_text() or ""
            if len(text.strip()) > 20:
                return True
    except Exception:  # noqa: BLE001
        # 无法读取时按有文本层处理，保证快速模式不会丢内容
        return True
    return False


def run_mineru_batch(pdfs: list[Path], work_dir: Path, backend: str,
                     method: str, lang: str, formula: bool, table: bool) -> None:
    """一次性调用 MinerU CPU 管线处理所有 PDF(模型只初始化一次)。"""
    try:
        from mineru.cli.common import do_parse
    except ImportError as exc:
        raise RuntimeError(
            f"无法加载 MinerU 库: {exc}\n"
            "请先安装: pip install mineru"
        ) from exc

    pdf_file_names = [p.name for p in pdfs]
    pdf_bytes_list = [p.read_bytes() for p in pdfs]
    p_lang_list = [lang] * len(pdfs)

    do_parse(
        output_dir=str(work_dir),
        pdf_file_names=pdf_file_names,
        pdf_bytes_list=pdf_bytes_list,
        p_lang_list=p_lang_list,
        backend=backend,
        parse_method=method,
        formula_enable=formula,
        table_enable=table,
        f_draw_layout_bbox=False,
        f_draw_span_bbox=False,
        f_dump_md=True,              # 只保留 md，其余中间产物全部丢弃
        f_dump_middle_json=False,
        f_dump_model_output=False,
        f_dump_orig_pdf=False,
        f_dump_content_list=False,
    )


def find_generated_md(work_dir: Path, pdf_stem: str) -> Path | None:
    """在 MinerU 输出目录中定位某个 PDF 生成的 md 文件。"""
    mds = [p for p in work_dir.rglob("*.md")]
    if not mds:
        return None
    # 优先选择与 PDF 同名(或目录名包含同名)的 md
    for md in mds:
        if md.stem == pdf_stem:
            return md
    for md in mds:
        if md.stem.startswith(pdf_stem):
            return md
    # 否则选最大的(通常是主文档)
    return max(mds, key=lambda p: p.stat().st_size)


def deliver_md(md_file: Path, dest_dir: Path, pdf_stem: str) -> Path:
    """把 md 及其 images 目录交付到目标文件夹，返回交付后的 md 路径。"""
    dest_dir.mkdir(parents=True, exist_ok=True)

    # 目标 md 路径(重名自动加序号)
    target_md = dest_dir / f"{pdf_stem}.md"
    if target_md.exists():
        i = 1
        while (dest_dir / f"{pdf_stem}_{i}.md").exists():
            i += 1
        target_md = dest_dir / f"{pdf_stem}_{i}.md"

    # 图片目录重命名: images -> <stem>_images，并重写 md 中的引用
    img_src = md_file.parent / IMAGE_SRC_DIR
    new_img_dir = f"{target_md.stem}_images"
    if img_src.is_dir():
        shutil.copytree(img_src, dest_dir / new_img_dir, dirs_exist_ok=True)

    text = md_file.read_text(encoding="utf-8", errors="replace")
    # 用替换函数避免文件名以数字开头时被误解析为正则反向引用
    text = re.sub(r"(\]\()images/", lambda m: m.group(1) + new_img_dir + "/", text)       # ![](images/x)
    text = re.sub(r'(src=["\'])images/', lambda m: m.group(1) + new_img_dir + "/", text)  # <img src="images/x">
    target_md.write_text(text, encoding="utf-8")
    return target_md


# ---------------------------------------------------------------- 主流程
def main() -> None:
    parser = argparse.ArgumentParser(
        description="使用 MinerU CPU 管线将 PDF 批量转换为 Markdown，"
                    "转换后自动清理中间产物并交付 md 到指定文件夹。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  python pdf2md.py a.pdf b.pdf -o D:\\md_output\n"
            "  python pdf2md.py -i a.pdf b.pdf -o out --lang ch\n"
            "  python pdf2md.py                    # 交互模式\n"
        ),
    )
    parser.add_argument("pdfs", nargs="*", help="一个或多个 PDF 文件路径(也支持目录)")
    parser.add_argument("-i", "--input", dest="input_list", nargs="*",
                        help="PDF 路径列表(与位置参数等效)")
    parser.add_argument("-o", "--output", default=None,
                        help="Markdown 交付目录(必填或交互指定)")
    parser.add_argument("-l", "--lang", default="ch",
                        help="文档语言，提升 OCR 精度，默认 ch(中英)")
    parser.add_argument("-m", "--method", default="auto",
                        choices=["auto", "txt", "ocr"],
                        help="解析方式: auto 自动判断 / txt 文本 / ocr 强制 OCR，默认 auto")
    parser.add_argument("-b", "--backend", default="pipeline",
                        choices=["pipeline", "hybrid-engine", "vlm-engine"],
                        help="MinerU 后端，默认 pipeline(经典 CPU 管线)")
    parser.add_argument("--fast", action="store_true",
                        help="快速模式: 自动跳过 OCR/公式/表格识别(仅适合有文本层的 PDF)")
    parser.add_argument("--no-formula", action="store_true", help="禁用公式识别")
    parser.add_argument("--no-table", action="store_true", help="禁用表格识别")
    args = parser.parse_args()

    # 收集输入
    raw_inputs = list(args.pdfs) + (list(args.input_list) if args.input_list else [])
    if raw_inputs and args.output:
        pdfs = expand_pdf_inputs(raw_inputs)
        dest_dir = Path(args.output)
    else:
        pdfs, dest_dir = interactive_collect()

    dest_dir.mkdir(parents=True, exist_ok=True)
    total = len(pdfs)
    print(f"\n共 {total} 个 PDF 待转换，交付目录: {dest_dir}")
    print("-" * 60)

    # 一次批量转换: 模型只加载一次，效率最高
    work_dir = Path(tempfile.mkdtemp(prefix="pdf2md_tmp_"))
    ok, failed = 0, 0
    delivered: list[Path] = []
    try:
        if args.fast:
            # 快速模式: 按是否有文本层分组，文本型跳过 OCR/公式/表格
            text_pdfs = [p for p in pdfs if has_text_layer(p)]
            scan_pdfs = [p for p in pdfs if not has_text_layer(p)]
            if text_pdfs:
                print(f"-> 快速模式: {len(text_pdfs)} 个文本型 PDF 跳过 OCR/公式/表格 ...")
                run_mineru_batch(text_pdfs, work_dir, args.backend, "txt",
                                 args.lang, formula=False, table=False)
            if scan_pdfs:
                print(f"-> 快速模式: {len(scan_pdfs)} 个扫描型 PDF 使用完整管线 ...")
                run_mineru_batch(scan_pdfs, work_dir, args.backend, "auto",
                                 args.lang, formula=not args.no_formula,
                                 table=not args.no_table)
        else:
            print("-> MinerU CPU 管线解析中(首次运行会自动下载模型，请耐心等待) ...")
            run_mineru_batch(
                pdfs, work_dir,
                backend=args.backend,
                method=args.method,
                lang=args.lang,
                formula=not args.no_formula,
                table=not args.no_table,
            )
        for idx, pdf in enumerate(pdfs, 1):
            try:
                md_file = find_generated_md(work_dir, pdf.stem)
                if md_file is None:
                    raise RuntimeError("未找到生成的 md 文件")
                target = deliver_md(md_file, dest_dir, pdf.stem)
                delivered.append(target)
                ok += 1
                print(f"[{idx}/{total}] [完成] {pdf.name} -> {target}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"[{idx}/{total}] [失败] {pdf.name}: {exc}")
    except Exception as exc:  # noqa: BLE001
        failed = total
        print(f"[错误] 批量转换中断: {exc}")
    finally:
        # 自动清除垃圾文件: 删除本次转换的全部中间产物
        shutil.rmtree(work_dir, ignore_errors=True)

    print("-" * 60)
    print(f"转换完成: 成功 {ok} 个，失败 {failed} 个")
    if delivered:
        print(f"交付目录: {dest_dir}")
        for d in delivered:
            print(f"  - {d}")
    if failed:
        print("失败的 PDF 请检查上方日志(常见原因: 模型未下载成功 / 文件损坏)。")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()

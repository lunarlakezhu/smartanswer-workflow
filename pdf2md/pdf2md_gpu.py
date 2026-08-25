#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PDF2MD GPU 版 — 使用 MinerU CUDA 管线将 PDF 批量转换为 Markdown

与 pdf2md.py 功能完全相同，区别仅在于使用本地 GPU(NVIDIA) 加速，
转换速度通常可提升 3~8 倍。

用法(与 CPU 版一致，参数完全相同):
  python pdf2md_gpu.py paper1.pdf paper2.pdf -o D:\md_output
  python pdf2md_gpu.py                    # 交互模式

注意:
  * 需要 NVIDIA 显卡且驱动支持 CUDA(本机为 RTX 3060)
  * 显存不足时可关闭其他占用显存的程序
"""

import os
import sys

# Windows 控制台输出 UTF-8，避免中文乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 先检查 GPU 是否可用
try:
    import torch
except ImportError:
    print("[错误] 未安装 torch，无法使用 GPU 加速。请先安装 CPU 版或重新安装 torch。")
    sys.exit(1)

if not torch.cuda.is_available():
    print("[错误] 未检测到可用的 NVIDIA GPU(CUDA)。")
    print("       请检查: 1) 显卡驱动是否安装  2) torch 是否为 CUDA 版本")
    print("       或者改用 CPU 版: 启动转换.bat / 拖拽转换.bat / 快速转换.bat")
    sys.exit(1)

print(f"[GPU] 检测到显卡: {torch.cuda.get_device_name(0)} "
      f"({round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 1)} GB)，使用 CUDA 加速")

# 复用 CPU 版的全部逻辑（其顶层会把设备设置为 cpu，这里再覆盖为 cuda）
import pdf2md  # noqa: E402

os.environ["MINERU_DEVICE_MODE"] = "cuda"  # 强制 CUDA 管线

if __name__ == "__main__":
    pdf2md.main()

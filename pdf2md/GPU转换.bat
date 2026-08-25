@echo off
chcp 65001 >nul
title PDF2MD GPU 加速转换（拖拽模式）
set "DEFAULT_OUT=E:\hana-workspace\OH-Works\综述写作\补充文献-md"
echo ============================================
echo   PDF2MD - GPU 加速转换（RTX 3060）
echo   用法：把 PDF 文件或文件夹拖到这个图标上
echo   特点：完整质量 + 显卡加速，速度提升 3~8 倍
echo ============================================
echo.
echo 拖入的内容：
echo   %*
echo.
set /p "OUTDIR=输出文件夹（直接回车用默认：%DEFAULT_OUT%）："
if "%OUTDIR%"=="" set "OUTDIR=%DEFAULT_OUT%"
echo.
echo 开始 GPU 加速转换，请耐心等待（首次运行需初始化显卡）...
echo.
"C:\Users\你的用户名\AppData\Local\Programs\Python\Python311\python.exe" "%~dp0pdf2md_gpu.py" %* -o "%OUTDIR%"
echo.
echo 转换结束，按任意键关闭窗口...
pause >nul

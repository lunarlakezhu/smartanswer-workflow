@echo off
chcp 65001 >nul
title PDF2MD 快速转换（拖拽模式）
set "DEFAULT_OUT=E:\hana-workspace\OH-Works\综述写作\补充文献-md"
echo ============================================
echo   PDF2MD - 快速转换
echo   用法：把 PDF 文件或文件夹拖到这个图标上
echo   特点：自动跳过 OCR/公式/表格，速度最快
echo   注意：只适合有文字层的 PDF（电子版论文）
echo ============================================
echo.
echo 拖入的内容：
echo   %*
echo.
set /p "OUTDIR=输出文件夹（直接回车用默认：%DEFAULT_OUT%）："
if "%OUTDIR%"=="" set "OUTDIR=%DEFAULT_OUT%"
echo.
echo 开始快速转换，请耐心等待...
echo.
"C:\Users\你的用户名\AppData\Local\Programs\Python\Python311\python.exe" "%~dp0pdf2md.py" --fast %* -o "%OUTDIR%"
echo.
echo 转换结束，按任意键关闭窗口...
pause >nul

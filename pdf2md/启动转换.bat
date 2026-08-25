@echo off
chcp 65001 >nul
title PDF2MD 转换工具
echo ============================================
echo   PDF2MD - PDF 转 Markdown 工具
echo   用法：按提示拖入 PDF 文件，输入输出文件夹
echo ============================================
echo.
"C:\Users\你的用户名\AppData\Local\Programs\Python\Python311\python.exe" "%~dp0pdf2md.py"
echo.
echo 转换结束，按任意键关闭窗口...
pause >nul

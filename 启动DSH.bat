@echo off
chcp 936 >nul
cd /d E:\deepseek-harness
echo ========================================
echo   DeepSeek Harness 正在启动...
echo   服务就绪后会自动打开浏览器
echo   关闭本窗口 = 停止服务
echo ========================================
echo.
start "" powershell -WindowStyle Hidden -Command "$t=New-Object Net.Sockets.TcpClient;for($i=0;$i -lt 90;$i++){Start-Sleep -Seconds 1;try{$t.Connect('127.0.0.1',3080);Start-Process 'http://127.0.0.1:3080';exit}catch{}}"
pnpm dsh web
pause
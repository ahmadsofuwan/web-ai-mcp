@echo off
title Install Native Host - Web AI MCP Agent
set "MANIFEST_PATH=%~dp0mcp-server\native-host\com.webaimcp.host.json"

echo Mendaftarkan Native Messaging Host: com.webaimcp.host
echo Manifest: %MANIFEST_PATH%
echo.

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.webaimcp.host" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.webaimcp.host" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.webaimcp.host" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul
reg add "HKCU\Software\Chromium\NativeMessagingHosts\com.webaimcp.host" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul

echo [OK] Native Host berhasil didaftarkan untuk Chrome, Edge, Brave, dan Chromium!
echo Sekarang Browser Extension bisa otomatis Start/Restart/Stop MCP Server tanpa terminal manual.
echo.
pause

@echo off
title Uninstall Native Host - Web AI MCP Agent
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.webaimcp.host" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.webaimcp.host" /f >nul 2>&1
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.webaimcp.host" /f >nul 2>&1
reg delete "HKCU\Software\Chromium\NativeMessagingHosts\com.webaimcp.host" /f >nul 2>&1
echo [OK] Native Host com.webaimcp.host berhasil dihapus dari Registry.
pause

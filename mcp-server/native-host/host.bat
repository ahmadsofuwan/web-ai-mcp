@echo off
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" "%~dp0host.js"
) else (
  node "%~dp0host.js"
)

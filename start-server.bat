@echo off
title Web AI MCP Server
cd /d "%~dp0mcp-server"

if not exist "node_modules" (
  echo Menginstall dependency MCP Server...
  call npm install
)

echo Menjalankan Web AI MCP Server...
node src\index.js
pause

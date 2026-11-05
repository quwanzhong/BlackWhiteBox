@echo off
chcp 65001 >nul
title 黑百盒 · 黑白盒测试平台
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause

@echo off
rem Same dashboard on built-in sample data (no internet needed).
cd /d "%~dp0"
python -m polymm.scan.app --offline
if errorlevel 1 pause

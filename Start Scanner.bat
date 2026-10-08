@echo off
rem Double-click to launch the prediction market scanner dashboard.
cd /d "%~dp0"
python -c "import truststore" 2>nul || python -m pip install --quiet truststore
python -m polymm.scan.app %*
if errorlevel 1 pause

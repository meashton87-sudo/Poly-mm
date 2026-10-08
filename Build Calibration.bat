@echo off
rem Builds calibration.json (historical win rates) from Jon Becker's
rem prediction-market-analysis dataset. One-time, takes a while (~36 GB).
rem Best: download https://s3.jbecker.dev/data.tar.zst in your browser first,
rem then drag that file onto this .bat. Without a file it streams the URL.
cd /d "%~dp0"
python -m pip install --quiet duckdb zstandard
if "%~1"=="" (
  python -m polymm.scan.calibrate --archive https://s3.jbecker.dev/data.tar.zst
) else (
  python -m polymm.scan.calibrate --archive "%~1"
)
pause

@echo off
rem Walk-forward backtest of the "Historical edge" strategy on real Kalshi history
rem (Jon Becker's prediction-market-analysis dataset).
rem Drag the downloaded data.tar.zst onto this file. The first run streams it into
rem backtest_kalshi.duckdb (several GB, one-time); later runs reuse that and take minutes.
cd /d "%~dp0"
python -m pip install --quiet duckdb zstandard
if not "%~1"=="" (
  python -m polymm.scan.backtest --archive "%~1"
) else if exist backtest_kalshi.duckdb (
  python -m polymm.scan.backtest --db backtest_kalshi.duckdb
) else (
  echo.
  echo No dataset yet, so this is a DEMO on made-up data.
  echo For the real thing, download https://s3.jbecker.dev/data.tar.zst and drag it onto this file.
  echo.
  python -m polymm.scan.backtest --demo
)
if exist backtest_report.html start "" backtest_report.html
pause

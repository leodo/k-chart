@echo off
cd /d "%~dp0"
.venv\Scripts\python.exe -m uvicorn backend.main:app --app-dir "%~dp0" --host 127.0.0.1 --port 8765

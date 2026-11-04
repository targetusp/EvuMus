@echo off
chcp 65001 >nul
cd /d "%~dp0ru-backend"
echo ============================================
echo   EvuMusic - запуск сервера обложек и API
echo ============================================
where py >nul 2>nul
if %errorlevel%==0 (
  py -m pip install -r requirements.txt
  py main.py
) else (
  python -m pip install -r requirements.txt
  python main.py
)
echo.
echo Сервер остановлен. Нажми любую клавишу для выхода.
pause >nul

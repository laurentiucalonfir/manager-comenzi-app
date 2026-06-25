@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0bump-version.ps1"
if %errorlevel% neq 0 pause & exit /b %errorlevel%
git add -A
git commit -m "update"
git push
echo.
echo Deploy spre Firebase...
call firebase deploy
echo.
echo Deploy efectuat!
pause

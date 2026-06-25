@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0bump-version.ps1"
if %errorlevel% neq 0 pause & exit /b %errorlevel%
git add -A
git commit -m "update"
git push
echo.
echo OPTIONAL: ruleaza "firebase deploy" pentru a publica pe Firebase Hosting.
echo.
echo Deploy efectuat!
pause

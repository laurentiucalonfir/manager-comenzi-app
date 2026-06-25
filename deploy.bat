@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0bump-version.ps1"
if %errorlevel% neq 0 pause & exit /b %errorlevel%
git add -A
git commit -m "update"
git push
echo.
where /q firebase && (
  echo Deploy pe Firebase Hosting...
  firebase deploy
) || (
  echo Firebase CLI negasit. Instaleaza Node.js si ruleaza: npm install -g firebase-tools
)
echo.
echo Deploy efectuat!
pause

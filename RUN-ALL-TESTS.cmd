@echo off
rem Sake of Health - runs every check. Double-click for the checks without a database.
rem For the MySQL 8 suites as well, run from a terminal after setting TEST_DB_HOST, TEST_DB_USER, TEST_DB_NAME:
rem     RUN-ALL-TESTS.cmd --mysql
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18 or newer is not installed. Get it from https://nodejs.org & pause & exit /b 1)
node scripts\run-all-tests.js %*
set RC=%ERRORLEVEL%
echo.
echo Finished. Results are in the test-results folder (see SUMMARY.txt).
pause
exit /b %RC%

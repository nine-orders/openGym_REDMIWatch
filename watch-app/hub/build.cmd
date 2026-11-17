@echo off
rem PC JVM gate for the watch hub core (watch-app/hub/core): the exact classes the
rem Android APK compiles. No SDK needed, plain javac + java. WatchHubTest covers the
rem JSON parser, the event queue, request parsing, and the whole frozen S3 contract
rem over a real socket (the curl smoke test, phoneless).
setlocal
cd /d %~dp0
where javac >nul 2>nul || (echo [hub] javac not on PATH & exit /b 1)
if not exist out mkdir out
javac -encoding UTF-8 -d out core\java\ch\duartesantos\opengym\watchhub\*.java javatest\WatchHubTest.java || exit /b 1
java -cp out WatchHubTest

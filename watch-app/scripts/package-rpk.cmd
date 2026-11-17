@echo off
rem watch rpk packaging pipeline (Windows, one-shot). The rpk is packaged under the
rem Android app's applicationId and signed with the Android debug certificate
rem (watch-app\sign\debug, converted from YOUR default debug.keystore: jks -> p12 -> pem,
rem see phone\README.md) -- interconnect pairing needs the two identities to match exactly.
rem Release signing needs your own release key (never in the repo).
rem Output: watch-app\dist\ch.duartesantos.opengym.debug.1.0.0.rpk (AstroBox installable).
rem Prereqs:
rem   1. env AIOT_PKG = aiot-toolkit packaging project root (node_modules in place)
rem   2. watch-app\sign\debug\{certificate.pem,private.pem} generated on your machine
rem Any failing step exits immediately with a non-zero code.
setlocal
for %%I in ("%~dp0..") do set "APP=%%~fI"
set "PKG=%AIOT_PKG%"
if "%PKG%"=="" (
  echo [FAIL] AIOT_PKG not set - point it at your aiot-toolkit packaging project root
  exit /b 1
)

echo [1/5] build-names (exercise name table; re-run after routine changes)
node "%APP%\scripts\build-names.mjs"
if errorlevel 1 ( echo [FAIL] build-names & exit /b 1 )

echo [2/5] copy src over the packaging project
xcopy /E /I /Y /Q "%APP%\src" "%PKG%\src" >nul
if errorlevel 1 ( echo [FAIL] xcopy src & exit /b 1 )

echo [3/5] copy signing material (Android debug cert so interconnect sees the same identity)
if not exist "%APP%\sign\debug\private.pem" (
  echo [FAIL] missing %APP%\sign\debug\private.pem - generate it from your debug.keystore, see phone\README.md
  exit /b 1
)
if not exist "%APP%\sign\debug\certificate.pem" (
  echo [FAIL] missing %APP%\sign\debug\certificate.pem - generate it from your debug.keystore, see phone\README.md
  exit /b 1
)
xcopy /E /I /Y /Q "%APP%\sign" "%PKG%\sign" >nul
if errorlevel 1 ( echo [FAIL] xcopy sign & exit /b 1 )

echo [4/5] aiot build (debug-signed rpk)
pushd "%PKG%"
call node_modules\.bin\aiot.cmd build
set "R=%errorlevel%"
popd
if not "%R%"=="0" ( echo [FAIL] aiot build exit=%R% & exit /b %R% )

echo [5/5] copy rpk back to watch-app\dist
if not exist "%APP%\dist" mkdir "%APP%\dist"
copy /Y "%PKG%\dist\ch.duartesantos.opengym.debug.1.0.0.rpk" "%APP%\dist\" >nul
if errorlevel 1 ( echo [FAIL] copy rpk & exit /b 1 )

echo [OK] %APP%\dist\ch.duartesantos.opengym.debug.1.0.0.rpk
endlocal

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $repo 'watch-app\hub\out\phone-bridge-test'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$sources = @(Get-ChildItem (Join-Path $PSScriptRoot 'stubs') -Recurse -Filter '*.java' | ForEach-Object FullName)
$sources += @(Get-ChildItem (Join-Path $repo 'watch-app\hub\core\java') -Recurse -Filter '*.java' | ForEach-Object FullName)
$sources += (Join-Path $repo 'phone\java\ch\duartesantos\opengym\WatchInterconnect.java'), (Join-Path $PSScriptRoot 'WatchInterconnectTest.java')
& javac -encoding UTF-8 -d $out @sources
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& java -cp $out ch.duartesantos.opengym.WatchInterconnectTest
exit $LASTEXITCODE

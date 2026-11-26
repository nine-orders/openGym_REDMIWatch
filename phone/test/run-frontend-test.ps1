param([string]$OpenGym = 'F:\AI\1_Projects\OpenGym')
$ErrorActionPreference = 'Stop'
$frontend = (Resolve-Path (Join-Path $OpenGym 'src\frontend')).Path
$lib = Join-Path $frontend 'src\lib'
$run = [Guid]::NewGuid().ToString('N')
$stagedSource = Join-Path $lib "redmi-$run.js"
$stagedTest = Join-Path $lib "redmi-$run.test.js"
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\frontend-lib\watch-sync.js') -Destination $stagedSource
    $test = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'watch-sync.hub.test.js')
    $test.Replace('./watch-sync.js', "./redmi-$run.js") | Set-Content -Encoding utf8 -LiteralPath $stagedTest
    Push-Location -LiteralPath $frontend
    try {
        & .\node_modules\.bin\vitest.cmd run "src/lib/redmi-$run.test.js"
        $result = $LASTEXITCODE
    } finally { Pop-Location }
} finally {
    if (Test-Path -LiteralPath $stagedSource) { Remove-Item -LiteralPath $stagedSource }
    if (Test-Path -LiteralPath $stagedTest) { Remove-Item -LiteralPath $stagedTest }
}
exit $result

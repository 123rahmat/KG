# Kindgleam build for Windows (PowerShell 5.1 or 7). Same steps as the Makefile:
#   1. compile every Java module with all warnings as errors, then make one jar per module;
#   2. build the assistant engine with g++ (MinGW-w64) or, if that is missing, MSVC cl;
#   3. refuse an engine that imports network or process functions.
# Fully offline: uses only the JDK and the C++ compiler already installed.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
Remove-Item Env:JAVA_TOOL_OPTIONS, Env:_JAVA_OPTIONS, Env:JDK_JAVA_OPTIONS -ErrorAction SilentlyContinue

$mods = 'kg.core','kg.gates','kg.sil','kg.rig','kg.verdict','kg.harness','kg.assist','kg.cli','kg.app'
$ver = (& javac -version 2>&1) -replace '^javac (\d+).*','$1'
$flags = if ($ver -eq '21') { @('--release','21','--enable-preview','-Xlint:-preview') } else { @('--release',$ver) }

Write-Host "== Java $ver"
Remove-Item -Recurse -Force build\classes, build\mods -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force build\classes, build\mods | Out-Null
$src = Get-ChildItem -Recurse -Filter *.java modules | ForEach-Object { $_.FullName }
$argfile = Join-Path $env:TEMP 'kg-javac-sources.txt'
$src | ForEach-Object { '"' + ($_ -replace '\\','/') + '"' } | Set-Content -Encoding ascii $argfile
& javac -Xlint:all @flags -Werror --module-source-path modules -d build\classes "@$argfile"
if ($LASTEXITCODE -ne 0) { throw 'Java compile failed' }
foreach ($m in $mods) {
    & jar --create --date=2026-01-01T00:00:00Z --file "build\mods\$m.jar" -C "build\classes\$m" .
    if ($LASTEXITCODE -ne 0) { throw "jar $m failed" }
}

Write-Host '== engine'
New-Item -ItemType Directory -Force engine\build | Out-Null
$exe = 'engine\build\kg-infer.exe'
if (Get-Command g++ -ErrorAction SilentlyContinue) {
    & g++ -std=c++17 -O3 -Wall -Wextra -Werror -Wconversion -Wno-sign-conversion -static -pthread -o $exe engine\src\main.cpp
} elseif (Get-Command cl -ErrorAction SilentlyContinue) {
    & cl /nologo /std:c++17 /O2 /EHsc /W4 /WX /wd4244 /wd4267 /Fe:$exe engine\src\main.cpp
} else {
    throw 'No C++ compiler found. Install MinGW-w64 (g++) or Visual Studio Build Tools (cl).'
}
if ($LASTEXITCODE -ne 0) { throw 'engine build failed' }

# The engine must import nothing from the Windows network or process APIs.
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $exe))
$text = [System.Text.Encoding]::ASCII.GetString($bytes)
foreach ($bad in 'WS2_32.dll','ws2_32.dll','WSOCK32.dll','WININET.dll','WINHTTP.dll','URLMON.dll','CreateProcessA','CreateProcessW','WinExec','ShellExecuteA','ShellExecuteW') {
    if ($text.Contains($bad)) { Remove-Item $exe; throw "engine imports forbidden $bad" }
}
Write-Host 'build OK'

# Builds the Windows desktop application with its own Java runtime inside (users need no Java):
#   dist\app\Kindgleam\Kindgleam.exe   portable folder
#   dist\app\Kindgleam-<version>.msi   installer with Start-menu entry and desktop shortcut (needs WiX 3)
#   dist\app\Kindgleam-<version>.exe   installer, if WiX is not available the .msi step is skipped
# If model\kindgleam-coder.gguf is present (tools\get-model.ps1 model) it is checked against the
# pinned fingerprint and shipped inside the app.
$ErrorActionPreference = 'Stop'
Set-Location -Path (Split-Path -Parent $PSScriptRoot)
Remove-Item Env:JAVA_TOOL_OPTIONS, Env:_JAVA_OPTIONS, Env:JDK_JAVA_OPTIONS -ErrorAction SilentlyContinue
$version = if ($env:KG_VERSION) { $env:KG_VERSION } else { '3.0.0' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

Write-Host '== build'
& .\build.ps1

$out = 'dist\app'
$stage = 'build\stage'
Remove-Item -Recurse -Force $out, $stage -ErrorAction SilentlyContinue
$c = "$stage\content"
New-Item -ItemType Directory -Force "$c\build", "$c\engine\build", "$c\model", "$c\examples", $out | Out-Null

Write-Host '== app content'
Copy-Item -Recurse build\mods "$c\build\"
Copy-Item engine\build\kg-infer.exe "$c\engine\build\"
foreach ($d in 'selftest', 'skills', 'firmware-support', 'docs', 'tools') { Copy-Item -Recurse $d "$c\" }
Get-ChildItem examples | ForEach-Object {
    if ($_.PSIsContainer) { robocopy $_.FullName "$c\examples\$($_.Name)" /E /XD jobs evidence memory /NFL /NDL /NJH /NJS | Out-Null }
    else { Copy-Item $_.FullName "$c\examples\" }
}
Copy-Item model\MODEL.txt, model\LICENSE-MODEL.txt "$c\model\"
Copy-Item README.md "$c\"
"PLATFORM windows $arch" | Set-Content -Encoding ascii "$c\platform.txt"
$manifest = Get-Content model\MODEL.txt
$mfile = ($manifest | Where-Object { $_ -like 'FILE *' }) -replace '^FILE ', ''
if (Test-Path "model\$mfile") {
    $got = (Get-FileHash -Algorithm SHA256 "model\$mfile").Hash.ToLower()
    $ok = @(($manifest | Where-Object { $_ -like 'SHA256 *' }) -replace '^SHA256 ', '') +
          @($manifest | Where-Object { $_ -like 'ALSO *' } | ForEach-Object { ($_ -split '\s+')[1] })
    if (-not ($ok -contains $got)) { throw "model\$mfile is not a published model file; refusing to ship it" }
    Copy-Item "model\$mfile" "$c\model\"
    Write-Host '   assistant model included'
} else {
    Write-Host '   no model file in model\: the app will offer tools\get-model on first use of the assistant'
}

Write-Host '== Java runtime for the app'
& jlink --add-modules 'java.base,java.desktop,java.xml,jdk.crypto.ec,jdk.zipfs' --strip-debug --no-man-pages --no-header-files --output "$stage\runtime"
if ($LASTEXITCODE -ne 0) { throw 'jlink failed' }

Write-Host '== application'
$content = (Get-ChildItem $c | ForEach-Object { $_.FullName }) -join ','
$opts = '--enable-preview -Xshare:off -Dkg.installed=true -Dkg.home=$APPDIR\.. -Dawt.useSystemAAFontSettings=on'
& jpackage --type app-image --dest $out --name Kindgleam --app-version $version --vendor Kindgleam `
    --description 'Offline SIL / PIL / HIL co-verification for embedded firmware' `
    --icon packaging\icons\kindgleam.ico --runtime-image "$stage\runtime" `
    --module-path build\mods --module kg.app/kg.app.App --app-content $content --java-options $opts
if ($LASTEXITCODE -ne 0) { throw 'jpackage app-image failed' }

$installer = if (Get-Command candle.exe -ErrorAction SilentlyContinue) { 'msi' } else { 'exe' }
& jpackage --type $installer --dest $out --app-image "$out\Kindgleam" --name Kindgleam --app-version $version `
    --vendor Kindgleam --win-menu --win-menu-group Kindgleam --win-shortcut --win-dir-chooser `
    --win-upgrade-uuid 6f1c2a52-6c0e-4b9a-9a2e-6b3d1d8f7a10
if ($LASTEXITCODE -ne 0) { Write-Host "   ($installer installer not built; the portable folder still works)" }
Compress-Archive -Path "$out\Kindgleam" -DestinationPath "$out\Kindgleam-$version-windows-$arch-portable.zip"
Get-ChildItem $out

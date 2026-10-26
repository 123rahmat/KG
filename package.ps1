# Builds the Windows package: dist\kindgleam-windows-<arch>\ and a .zip of it.
# The model file, if present in model\, is checked against the pinned SHA-256 and packed unchanged.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "kindgleam-windows-$arch"
$out = "dist\$name"

& "$PSScriptRoot\build.ps1"

Write-Host "== assembling $out"
Remove-Item -Recurse -Force $out, "dist\$name.zip" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\bin", "$out\build", "$out\engine\build", "$out\model", "$out\examples" | Out-Null
Copy-Item bin\kindgleam.cmd, bin\kindgleam-app.cmd "$out\bin\"
Copy-Item -Recurse build\mods "$out\build\"
Copy-Item engine\build\kg-infer.exe "$out\engine\build\"
Copy-Item -Recurse engine\src "$out\engine\"
foreach ($d in 'firmware-support','skills','selftest','docs') { Copy-Item -Recurse $d "$out\" }
Get-ChildItem examples | ForEach-Object {
    if ($_.PSIsContainer) {
        $dst = "$out\examples\$($_.Name)"
        robocopy $_.FullName $dst /E /XD jobs evidence memory /NFL /NDL /NJH /NJS | Out-Null
    } else { Copy-Item $_.FullName "$out\examples\" }
}
Copy-Item README.md "$out\"
Copy-Item model\MODEL.txt, model\LICENSE-MODEL.txt "$out\model\"
"PLATFORM windows $arch" | Set-Content -Encoding ascii "$out\platform.txt"

$pin = ((Get-Content model\MODEL.txt) | Where-Object { $_ -like 'SHA256 *' }) -replace '^SHA256 ',''
$mfile = ((Get-Content model\MODEL.txt) | Where-Object { $_ -like 'FILE *' }) -replace '^FILE ',''
if (Test-Path "model\$mfile") {
    Write-Host "== checking model\$mfile against the pinned fingerprint"
    $got = (Get-FileHash -Algorithm SHA256 "model\$mfile").Hash.ToLower()
    $also = (Get-Content model\MODEL.txt) | Where-Object { $_ -like 'ALSO *' } | ForEach-Object { ($_ -split '\s+')[1] }
    if ($got -ne $pin -and -not ($also -contains $got)) { throw "model\$mfile is not the published model (got $got, need $pin)" }
    Copy-Item "model\$mfile" "$out\model\"
} else {
    Write-Host '   NOTE: no model file in model\; the assistant will ask for it on first use'
}

Write-Host '== fingerprints'
$root = (Resolve-Path $out).Path
Get-ChildItem -Recurse -File $out | Where-Object { $_.Name -ne 'SHA256SUMS' } | Sort-Object FullName | ForEach-Object {
    $rel = '.' + $_.FullName.Substring($root.Length).Replace('\','/')
    (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower() + '  ' + $rel
} | Set-Content -Encoding ascii "$out\SHA256SUMS"
@"
Checking this Kindgleam package

Every file is listed with its SHA-256 fingerprint in SHA256SUMS. In PowerShell:
  cd $name
  Get-Content SHA256SUMS | ForEach-Object { `$h,`$f = `$_ -split '  ',2; if ((Get-FileHash -Algorithm SHA256 `$f).Hash.ToLower() -ne `$h) { "CHANGED: `$f" } }
No output means every file is exactly as packaged.
"@ | Set-Content -Encoding ascii "$out\VERIFY.txt"

Write-Host '== compressing'
Compress-Archive -Path $out -DestinationPath "dist\$name.zip"
Write-Host "done: dist\$name.zip"
exit 0

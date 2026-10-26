# Downloads the assistant's model ONCE, checks it against the fingerprint pinned in model\MODEL.txt,
# and puts it where Kindgleam looks for it. The only network use in the Kindgleam folder; Kindgleam
# itself contains no network code.
#   tools\get-model.cmd (double-click)   put it in this Kindgleam's own model folder; asks for administrator
#                                       rights when Kindgleam is installed in Program Files. Uninstalling removes it.
param([string]$Dest = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content "$here\model\MODEL.txt"
$url = (($manifest | Where-Object { $_ -like 'SOURCE *' }) -replace '^SOURCE ', '') -replace '/blob/', '/resolve/'
$pin = ($manifest | Where-Object { $_ -like 'SHA256 *' }) -replace '^SHA256 ', ''
$file = ($manifest | Where-Object { $_ -like 'FILE *' }) -replace '^FILE ', ''
if ($Dest -eq '' -or $Dest -eq 'model') { $Dest = "$here\model" }
New-Item -ItemType Directory -Force $Dest | Out-Null
$out = Join-Path $Dest $file
if ((Test-Path $out) -and ((Get-FileHash -Algorithm SHA256 $out).Hash.ToLower() -eq $pin)) {
    Write-Host "The model is already in place and correct: $out"; exit 0
}
Write-Host "Downloading the Kindgleam assistant model (about 1.1 GB) from:`n  $url"
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $url -OutFile "$out.part" -UseBasicParsing
Write-Host 'Checking the fingerprint...'
$got = (Get-FileHash -Algorithm SHA256 "$out.part").Hash.ToLower()
if ($got -ne $pin) { Remove-Item "$out.part"; throw "WRONG FILE: fingerprint $got, expected $pin. Nothing was installed." }
Move-Item -Force "$out.part" $out
Write-Host "Done: $out"
Write-Host 'The assistant is ready: open Kindgleam, go to Code and turn the assistant on in Settings.'

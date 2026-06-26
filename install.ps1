$ErrorActionPreference = "Stop"

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ItpBin = Join-Path $SourceDir "bin\itp"
$LibDir = Join-Path $SourceDir "lib"
$SkillsDir = Join-Path $SourceDir "skills"
$DocsDir = Join-Path $SourceDir "docs"
$NodeModules = Join-Path $SourceDir "node_modules"
$PackageFile = Join-Path $SourceDir "package.json"
$Prefix = if ($env:ITP_PREFIX) { $env:ITP_PREFIX } else { Join-Path $HOME ".local" }
$TargetDir = Join-Path $Prefix "bin"
$TargetScript = Join-Path $TargetDir "itp.js"
$TargetCmd = Join-Path $TargetDir "itp.cmd"
$LibTarget = Join-Path $Prefix "lib"
$ModuleTarget = Join-Path $Prefix "node_modules"
$ShareTargetDir = Join-Path $Prefix "share\itpay_cli"
$SkillsTarget = Join-Path $ShareTargetDir "skills"
$DocsTarget = Join-Path $ShareTargetDir "docs"
$PackageTarget = Join-Path $ShareTargetDir "package.json"

if (!(Test-Path $ItpBin)) {
  throw "itp binary not found at $ItpBin"
}

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
Copy-Item -Force $ItpBin $TargetScript
if (Test-Path $LibDir) {
  if (Test-Path $LibTarget) {
    Remove-Item -Recurse -Force $LibTarget
  }
  Copy-Item -Recurse -Force $LibDir $LibTarget
}
if (Test-Path $NodeModules) {
  if (Test-Path $ModuleTarget) {
    Remove-Item -Recurse -Force $ModuleTarget
  }
  Copy-Item -Recurse -Force $NodeModules $ModuleTarget
}
New-Item -ItemType Directory -Force -Path $ShareTargetDir | Out-Null
if (Test-Path $PackageFile) {
  Copy-Item -Force $PackageFile $PackageTarget
}
if (Test-Path $SkillsDir) {
  if (Test-Path $SkillsTarget) {
    Remove-Item -Recurse -Force $SkillsTarget
  }
  Copy-Item -Recurse -Force $SkillsDir $SkillsTarget
}
if (Test-Path $DocsDir) {
  if (Test-Path $DocsTarget) {
    Remove-Item -Recurse -Force $DocsTarget
  }
  Copy-Item -Recurse -Force $DocsDir $DocsTarget
}
Set-Content -Path $TargetCmd -Encoding ASCII -Value @"
@echo off
node "%~dp0itp.js" %*
"@

Write-Output "Installed itp to $TargetCmd"
if (($env:Path -split ';') -notcontains $TargetDir) {
  Write-Output "Add $TargetDir to PATH before running itp."
} else {
  & $TargetCmd --version
}

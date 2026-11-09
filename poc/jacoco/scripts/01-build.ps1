# 01-build.ps1 — 编译 PoC fixture 与 HTTP 壳（零第三方依赖，只用 JDK）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$classes = Join-Path $root "out\classes"

$javaHome = ((java -XshowSettings:properties -version 2>&1 |
  Select-String 'java\.home\s*=' |
  ForEach-Object { ($_ -split '=', 2)[1].Trim() }) | Select-Object -First 1)
if (-not $javaHome) { throw "未找到 JDK，请确保 java 可用" }
$javac = Join-Path $javaHome "bin\javac.exe"
if (-not (Test-Path $javac)) { $javac = (Get-Command javac).Source }

if (Test-Path $classes) { Remove-Item -Recurse -Force $classes }
New-Item -ItemType Directory -Force -Path $classes | Out-Null

$files = Get-ChildItem (Join-Path $root "fixture\src"), (Join-Path $root "harness\src") -Recurse -Filter *.java |
  ForEach-Object { $_.FullName }

& $javac -encoding UTF-8 -d $classes $files
if ($LASTEXITCODE -ne 0) { throw "javac 编译失败" }

$count = (Get-ChildItem $classes -Recurse -Filter *.class | Measure-Object).Count
Write-Host "编译完成：$count 个 class -> $classes"

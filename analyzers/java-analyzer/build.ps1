# 黑百盒 · Java 白盒分析器构建脚本（无需 Maven，JDK 17+ 直接编译）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $root "src\main\java"
$out  = Join-Path $root "out"
$jar  = Join-Path $root "java-analyzer.jar"

# 解析 JDK 家目录（有些机器 PATH 里只有 javapath，没有 jar.exe）
$props = cmd /c "java -XshowSettings:properties -version 2>&1"
$javaHome = ($props | Select-String 'java\.home\s*=' | ForEach-Object { ($_ -split '=', 2)[1].Trim() } | Select-Object -First 1)
if (-not $javaHome -or -not (Test-Path $javaHome)) {
  throw "未找到 JDK：请安装 JDK 17+ 并确保 java 命令可用"
}

$javac = Join-Path $javaHome "bin\javac.exe"
$jarExe = Join-Path $javaHome "bin\jar.exe"
if (-not (Test-Path $javac)) { $javac = (Get-Command javac).Source }
if (-not (Test-Path $jarExe)) { $jarExe = Join-Path (Split-Path $javac) "jar.exe" }
if (-not (Test-Path $jarExe)) { throw "未找到 jar.exe（$javaHome\bin）" }

Write-Host "JDK：$javaHome"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "编译源码：$src"
$files = Get-ChildItem -Path $src -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& $javac -encoding UTF-8 -d $out $files
if ($LASTEXITCODE -ne 0) { throw "javac 编译失败" }

Write-Host "打包 jar：$jar"
if (Test-Path $jar) { Remove-Item -Force $jar }
& $jarExe --create --file $jar --main-class com.heibaihe.analyzer.Main -C $out .
if ($LASTEXITCODE -ne 0) { throw "jar 打包失败" }

Write-Host ""
Write-Host "构建完成：$jar"
Write-Host "试运行：java -jar `"$jar`" --project `"$root\samples\demo`" --out `"$root\flows.json`""

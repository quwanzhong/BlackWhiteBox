# 黑百盒 · 一键启动脚本（Windows PowerShell）
# 作用：检查环境 → 安装依赖 → 构建前端 → 启动服务 → 打开浏览器
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:PORT) { $env:PORT } else { "3310" }
$url = "http://localhost:$port"

function Write-Step($text) {
  Write-Host ""
  Write-Host "==> $text" -ForegroundColor Cyan
}

function Fail($text) {
  Write-Host ""
  Write-Host "[失败] $text" -ForegroundColor Red
  Write-Host ""
  Read-Host "按回车退出"
  exit 1
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor DarkCyan
Write-Host "  黑百盒 · 黑白盒测试平台（单机版）" -ForegroundColor White
Write-Host "==============================================" -ForegroundColor DarkCyan

# ---------- 1. 环境检查 ----------
Write-Step "检查运行环境"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "未找到 Node.js，请先安装 Node.js 18+（https://nodejs.org/）"
}
$nodeVersion = (& node -v).TrimStart("v")
$major = [int]($nodeVersion.Split(".")[0])
Write-Host "Node.js $nodeVersion"
if ($major -lt 18) {
  Fail "Node.js 版本过低（当前 $nodeVersion），需要 18 及以上"
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Fail "未找到 npm，请重新安装 Node.js" }

# ---------- 2. 安装依赖 ----------
Write-Step "检查依赖"
$needInstall = $false
if (-not (Test-Path (Join-Path $root "backend\node_modules"))) { $needInstall = $true }
if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) { $needInstall = $true }

if ($needInstall) {
  Write-Host "首次启动，正在安装依赖（可能需要几分钟）..." -ForegroundColor Yellow
  & npm install --prefix (Join-Path $root "backend")
  if ($LASTEXITCODE -ne 0) { Fail "后端依赖安装失败" }
  & npm install --prefix (Join-Path $root "frontend")
  if ($LASTEXITCODE -ne 0) { Fail "前端依赖安装失败" }
} else {
  Write-Host "依赖已就绪" -ForegroundColor Green
}

# ---------- 3. 构建前端 ----------
$dist = Join-Path $root "frontend\dist"
$needBuild = -not (Test-Path (Join-Path $dist "index.html"))
if (-not $needBuild) {
  $srcTime = (Get-ChildItem (Join-Path $root "frontend\src") -Recurse -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
  $distTime = (Get-Item (Join-Path $dist "index.html")).LastWriteTime
  if ($srcTime -gt $distTime) { $needBuild = $true }
}

if ($needBuild) {
  Write-Step "构建前端界面"
  & npm run build --prefix (Join-Path $root "frontend")
  if ($LASTEXITCODE -ne 0) { Fail "前端构建失败" }
  Write-Host "构建完成" -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "前端产物已是最新，跳过构建" -ForegroundColor Green
}

# ---------- 4. 端口检查 ----------
Write-Step "检查端口 $port"
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $ownerPid = ($busy | Select-Object -First 1).OwningProcess
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  $name = if ($proc) { $proc.ProcessName } else { "未知进程" }
  Write-Host "端口 $port 已被占用（PID $ownerPid / $name）" -ForegroundColor Yellow
  $choice = Read-Host "是否停止该进程后继续？(Y/N)"
  if ($choice -match '^(y|Y)') {
    Stop-Process -Id $ownerPid -Force
    Start-Sleep -Milliseconds 800
  } else {
    Fail "端口被占用，无法启动。可设置环境变量 PORT 换一个端口，例如：`$env:PORT=3311"
  }
}

# ---------- 5. 启动 ----------
Write-Step "启动服务"
Write-Host "服务地址：$url" -ForegroundColor Green
Write-Host "健康检查：$url/api/health" -ForegroundColor DarkGray
Write-Host "按 Ctrl+C 停止服务" -ForegroundColor DarkGray
Write-Host ""

Start-Process $url
& npm run start --prefix (Join-Path $root "backend")

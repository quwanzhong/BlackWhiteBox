# 02-run-server.ps1 — 带 JaCoCo agent 启动 demo 服务
# 关键点：output=tcpserver 让 agent 监听 TCP，Node 侧才能按节点 reset/dump
param(
  [int]$Port = 8089,
  [int]$AgentPort = 6300
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$classes = Join-Path $root "out\classes"
$agent = Join-Path $root "tools\jacocoagent.jar"
if (-not (Test-Path $classes)) { throw "请先执行 01-build.ps1" }
if (-not (Test-Path $agent)) { throw "缺少 tools\jacocoagent.jar，请先执行 00-fetch-jars.ps1" }

$opts = "port=$AgentPort,address=127.0.0.1,output=tcpserver,includes=com.poc.*"
Write-Host "启动：port=$Port agent=$AgentPort"
& java "-javaagent:$agent=$opts" -cp $classes com.poc.harness.DemoHttpServer --port $Port

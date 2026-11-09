# 04-report.ps1 — 每个节点的 .exec → JaCoCo XML
# 每节点一次 jacococli 是 PoC 的"最笨但正确"做法；正式实现会批量分析。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root "out"
$cli = Join-Path $root "tools\jacococli.jar"
$classes = Join-Path $out "classes"
$sources = @((Join-Path $root "fixture\src"), (Join-Path $root "harness\src"))

$execs = Get-ChildItem $out -Filter "node-*.exec" | Sort-Object Name
if (-not $execs) { throw "没有找到 node-*.exec，请先执行 03-probe.mjs" }

foreach ($exec in $execs) {
  $xml = Join-Path $out ($exec.BaseName + ".xml")
  $t0 = Get-Date
  # 注意：--sourcefiles 只能给一个目录，这里用 fixture（业务代码所在）
  & java -jar $cli report $exec.FullName --classfiles $classes --sourcefiles (Join-Path $root "fixture\src") --xml $xml 2>&1 |
    ForEach-Object { if ($_ -notmatch '^\s*$') { Write-Host "  $_" } }
  if ($LASTEXITCODE -ne 0) { throw "jacococli 失败：$($exec.Name)" }
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  Write-Host ("{0} -> {1} ({2} ms)" -f $exec.Name, (Split-Path -Leaf $xml), $ms)
}
Write-Host "报告生成完成：$out"

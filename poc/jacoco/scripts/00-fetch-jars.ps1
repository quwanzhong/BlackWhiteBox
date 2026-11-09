# 00-fetch-jars.ps1 — 从 Maven Central 下载 JaCoCo agent 与 CLI，并校验 SHA-1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tools = Join-Path $root "tools"
New-Item -ItemType Directory -Force -Path $tools | Out-Null

$items = @(
  @{ Url = "https://repo1.maven.org/maven2/org/jacoco/org.jacoco.agent/0.8.12/org.jacoco.agent-0.8.12-runtime.jar"; Out = "jacocoagent.jar" },
  @{ Url = "https://repo1.maven.org/maven2/org/jacoco/org.jacoco.cli/0.8.12/org.jacoco.cli-0.8.12-nodeps.jar"; Out = "jacococli.jar" }
)

foreach ($item in $items) {
  $dest = Join-Path $tools $item.Out
  if (Test-Path $dest) {
    Write-Host "已存在，跳过下载：$($item.Out)"
  } else {
    Write-Host "下载：$($item.Url)"
    Invoke-WebRequest -Uri $item.Url -OutFile $dest -UseBasicParsing
  }
  $expected = (Invoke-WebRequest -Uri "$($item.Url).sha1" -UseBasicParsing).Content.Trim().Split(' ')[0]
  $actual = (Get-FileHash -Algorithm SHA1 -Path $dest).Hash.ToLower()
  if ($expected -ne $actual) { throw "SHA-1 校验失败：$($item.Out) expected=$expected actual=$actual" }
  Write-Host "  OK  $($item.Out)  $([math]::Round((Get-Item $dest).Length / 1KB, 0)) KB  sha1=$actual"
}

# 注意：-javaagent 必须用 -runtime 分类器（带 Premain-Class），
# 主 jar 是 API，挂上去会报 "no Premain-Class"。

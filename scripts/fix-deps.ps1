# dsh-token-billing 依赖修复脚本（Windows / PowerShell）
#
# 现象：`dsh web` 启动时报
#   Cannot find package '@deepseek-ai/dsh-settings' imported from ...\lib\index.js
# 原因：pnpm install（如 dsh plugin add 新插件）会重建 link 包的 node_modules，
#       把 dsh-settings / zod 的链接清空，留下空目录。
# 修复：从 DSH 本体（npm 全局安装）重新建 Junction 链接。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\fix-deps.ps1
$ErrorActionPreference = 'Stop'

$plug = Join-Path $PSScriptRoot '..\node_modules'
$dshCandidates = @(
  'D:\npm-global\node_modules\@deepseek-ai\dsh\node_modules',
  (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules'),
  (Join-Path $env:USERPROFILE 'AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules'),
)

$dsh = $null
foreach ($c in $dshCandidates) {
  if (Test-Path (Join-Path $c '@deepseek-ai\dsh-settings\package.json')) { $dsh = $c; break }
}
if (-not $dsh) {
  Write-Host '✗ 未找到 DSH 本体的 dsh-settings（请确认 dsh 的 npm 全局安装路径）' -ForegroundColor Red
  exit 1
}
Write-Host "DSH 本体依赖目录: $dsh"

$pairs = @(
  @{ name = 'dsh-settings'; rel = '@deepseek-ai\dsh-settings' },
  @{ name = 'zod'; rel = 'zod' },
)

foreach ($p in $pairs) {
  $target = Join-Path $dsh $p.rel
  $link = Join-Path $plug $p.rel
  if (Test-Path $link) { Remove-Item $link -Recurse -Force }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  if (Test-Path (Join-Path $link 'package.json')) {
    Write-Host "✓ $($p.name) 已链接"
  } else {
    Write-Host "✗ $($p.name) 链接失败" -ForegroundColor Red
  }
}

Write-Host ''
Write-Host '修复完成，重新运行 `dsh web` 即可。'

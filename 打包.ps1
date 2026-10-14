# 一键打包正式版
# 用法: .\打包.ps1
#
# 做的事:
#   1. 把被占用的旧产物改名挪开 (不关闭正在运行的 awei-work)
#   2. 类型检查
#   3. Build the frontend, mobile page and Rust backend
#   4. 生成 NSIS 安装包
#
# 打包过程中可以继续用正在开着的 awei-work, 它跑的还是旧版本,
# 想用新版本自己重启一下就行.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

function Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

$startTime = Get-Date

$releaseExe = Join-Path $root "src-tauri\target\release\awei-work.exe"

# 文件是不是被别的进程占着写不了
function Test-FileLocked($path) {
    try {
        $fs = [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None')
        $fs.Dispose()
        return $false
    } catch {
        return $true
    }
}

Step "挪开被占用的旧产物"
# Windows 允许重命名正在运行的 exe: 把被占用的旧文件改个名让开位置,
# 链接器就能写新文件; 已经开着的 awei-work 继续用改名后的旧文件, 不受影响.
# 改名留下的 *.locked-* 等下次打包 (那个进程退出后) 自动清掉.
$outDirs = @(
    (Join-Path $root "src-tauri\target\release")
)

$locked = @()
foreach ($dir in $outDirs) {
    if (-not (Test-Path $dir)) { continue }
    foreach ($f in Get-ChildItem $dir -File -ErrorAction SilentlyContinue) {
        if ($f.Name -notlike "awei-work*") { continue }
        if ($f.Name -like "*.locked-*") {
            # 上次挪开的, 现在没人占了就删掉
            if (-not (Test-FileLocked $f.FullName)) {
                Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
            }
            continue
        }
        if ($f.Extension -ne ".exe" -and $f.Extension -ne ".pdb") { continue }
        if (Test-FileLocked $f.FullName) { $locked += $f }
    }
}

if ($locked) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    foreach ($f in $locked) {
        try {
            Rename-Item -LiteralPath $f.FullName -NewName "$($f.Name).locked-$stamp" -ErrorAction Stop
            Write-Host "  已挪开 $($f.Name)" -ForegroundColor Gray
        } catch {
            Write-Host "  挪不开 $($f.FullName)" -ForegroundColor Red
            Write-Host "  请手动关掉占用它的程序再打包" -ForegroundColor Red
            exit 1
        }
    }
} else {
    Write-Host "  没有被占用的文件" -ForegroundColor Gray
}

$running = Get-Process -Name "awei-work" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase) }
if ($running) {
    Write-Host "  正式版 awei-work 保持运行 ($($running.Count) 个), 跑的仍是旧版本" -ForegroundColor Gray
}

Step "类型检查"
& pnpm check-types
if ($LASTEXITCODE -ne 0) {
    Write-Host "类型检查失败, 停止打包" -ForegroundColor Red
    exit 1
}
Write-Host "  通过" -ForegroundColor Green

Step "编译打包 (CLI + 前端 + Rust, 大约 5-6 分钟)"
& pnpm tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host "编译打包失败，不使用旧产物判断成功" -ForegroundColor Red
    exit 1
}
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$exe   = $releaseExe
$nsis  = Join-Path $root "src-tauri\target\release\bundle\nsis\awei-work_${version}_x64-setup.exe"

Step "产物"
$ok = $true
foreach ($p in @($exe, $nsis)) {
    if (Test-Path $p) {
        $size = [math]::Round((Get-Item $p).Length / 1MB, 1)
        $time = (Get-Item $p).LastWriteTime.ToString("HH:mm:ss")
        Write-Host ("  {0,-8} {1,6} MB   {2}" -f $time, $size, $p) -ForegroundColor Green
    } else {
        Write-Host "  缺失: $p" -ForegroundColor Red
        $ok = $false
    }
}

$elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds)
Write-Host ""
if ($ok) {
    Write-Host "打包完成, 用时 ${elapsed}s" -ForegroundColor Green
    Write-Host "安装包: $nsis" -ForegroundColor Gray
    exit 0
} else {
    Write-Host "打包失败, 用时 ${elapsed}s" -ForegroundColor Red
    exit 1
}

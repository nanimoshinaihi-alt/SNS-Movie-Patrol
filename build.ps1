# src/ から Chrome 用と Firefox/Floorp 用の拡張を dist/ に出力する。
#   dist/chrome  : src/ のコピー(manifest は src/manifest.json のまま)
#   dist/firefox : manifest を Firefox 向けに書き換えたもの
#   dist/sns-movie-patrol-{chrome,firefox}-v<バージョン>.zip : 配布用
# 使い方: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'src'
$dist = Join-Path $PSScriptRoot 'dist'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Copy-Source($name) {
    $out = Join-Path $dist $name
    if (Test-Path $out) { Remove-Item $out -Recurse -Force }
    New-Item -ItemType Directory -Force $out | Out-Null
    Copy-Item (Join-Path $src '*') $out -Recurse
    return $out
}

# ---- Chrome ----
$chromeOut = Copy-Source 'chrome'

# ---- Firefox / Floorp ----
$firefoxOut = Copy-Source 'firefox'
$manifestPath = Join-Path $firefoxOut 'manifest.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath, $utf8NoBom) | ConvertFrom-Json

# Firefox はサービスワーカーではなくバックグラウンドスクリプトで動かす
$manifest.background = [ordered]@{
    scripts = @('background.js')
    type    = 'module'
}
# 拡張IDを固定する(IDが変わると保存した巡回先や履歴が引き継がれない)。
# content_scripts の world: MAIN が使えるのが Firefox 128 以降。
$manifest | Add-Member -NotePropertyName 'browser_specific_settings' -NotePropertyValue ([ordered]@{
    gecko = [ordered]@{
        id                          = 'sns-movie-patrol@local'
        strict_min_version          = '128.0'
        data_collection_permissions = [ordered]@{ required = @('none') }
    }
})

[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8NoBom)

# ---- 配布用 zip ----
# Compress-Archive は古い PowerShell だと zip 内の区切りが「\」になり、Windows 以外や Firefox で
# 読めないことがあるので、区切りを「/」にして自前で詰める。
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-Zip($sourceDir, $zipPath, $prefix) {
    if (Test-Path $zipPath) { [System.IO.File]::Delete($zipPath) }
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
    try {
        foreach ($file in Get-ChildItem $sourceDir -Recurse -File) {
            $relative = $file.FullName.Substring($sourceDir.Length + 1).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $prefix + $relative) | Out-Null
        }
    }
    finally { $zip.Dispose() }
}

$version = $manifest.version
# Chrome 用は展開するとフォルダが1つ出てくる形(そのフォルダを「パッケージ化されていない拡張機能」として読み込む)
$chromeZip = Join-Path $dist "sns-movie-patrol-chrome-v$version.zip"
New-Zip $chromeOut $chromeZip 'sns-movie-patrol/'
# Firefox 用は zip の直下に manifest.json が必要(一時的なアドオンとして zip のまま読み込める)
$firefoxZip = Join-Path $dist "sns-movie-patrol-firefox-v$version.zip"
New-Zip $firefoxOut $firefoxZip ''

Write-Host "Chrome  : $chromeOut"
Write-Host "Firefox : $firefoxOut"
Write-Host "Zip     : $chromeZip"
Write-Host "Zip     : $firefoxZip"

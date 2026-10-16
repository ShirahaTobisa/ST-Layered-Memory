$ErrorActionPreference = 'Stop'
$product = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -Raw -LiteralPath (Join-Path $product 'package.json') | ConvertFrom-Json).version
$release = Join-Path $product "release/v$version"
New-Item -ItemType Directory -Force -Path $release | Out-Null
$manifest = Get-Content -Raw -LiteralPath (Join-Path $product 'manifest.json') | ConvertFrom-Json
if ($manifest.version -ne $version) { throw 'Manifest version mismatch' }
$entries = @()
foreach ($kind in @('frontend', 'server')) {
    $names = @('README.md', 'SPEC.md', 'ACCEPTANCE.md', 'NOTICE.md', 'LICENSE')
    if ($kind -eq 'frontend') { $names += @('manifest.json', 'client', 'shared') }
    else { $names += @('package.json', 'package-lock.json', 'server', 'shared') }
    foreach ($name in $names) {
        $item = Get-Item -LiteralPath (Join-Path $product $name)
        $files = if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $item.FullName -File -Recurse } else { @($item) }
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($product.Length + 1).Replace('\', '/')
            $entries += [pscustomobject]@{ source = $file.FullName; path = "$kind/ST-Layered-Memory/$relative"; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
        }
    }
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $product 'evidence') -File) {
    $entries += [pscustomobject]@{ source = $file.FullName; path = "evidence/$($file.Name)"; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
foreach ($file in $entries.source | Select-Object -Unique | Where-Object { $_.EndsWith('.js') }) {
    & node --check $file
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $file" }
}
$zipPath = Join-Path $release "ST-Layered-Memory-$version-$(Get-Date -Format yyyyMMdd).zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($entry in $entries) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $entry.source, $entry.path, [IO.Compression.CompressionLevel]::Optimal) | Out-Null }
} finally { $archive.Dispose() }
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    if ($archive.Entries.Count -ne $entries.Count) { throw 'Entry count mismatch' }
    foreach ($expected in $entries) {
        $actual = $archive.GetEntry($expected.path)
        if (!$actual -or $actual.Length -ne $expected.bytes) { throw 'Size mismatch' }
        $stream = $actual.Open(); $sha = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $sha.Dispose() }
        if ($digest -ne $expected.sha256) { throw "Hash mismatch: $($expected.path)" }
    }
} finally { $archive.Dispose() }
$inventory = Join-Path $release 'FILES.json'
$entries | Select-Object path,bytes,sha256 | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $inventory -Encoding utf8
@($zipPath, $inventory) | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($_) } | Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Encoding utf8
[ordered]@{ checkedAt = (Get-Date).ToString('o'); entries = $entries.Count; allSizesAndHashesMatch = $true; zipBytes = (Get-Item -LiteralPath $zipPath).Length } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $release 'package-verification.json') -Encoding utf8
Write-Output "Verified $($entries.Count) package entries: $zipPath"

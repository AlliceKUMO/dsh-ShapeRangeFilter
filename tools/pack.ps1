<#
.SYNOPSIS
    Package the plugin into a .eagleplugin archive.

.DESCRIPTION
    Stages only the files Eagle needs at runtime, then zips them with
    manifest.json at the archive root. Development-only content (test/,
    tools/, node_modules/) is never included, so there is no exclude-list
    to keep in sync as the project grows: the runtime set is an allowlist.

    Eagle's own "Pack Plugin" command is the authoritative packer; this
    script exists so packaging is scriptable and reviewable.

.EXAMPLE
    pwsh -File tools/pack.ps1
    pwsh -File tools/pack.ps1 -OutputDirectory D:\dist
#>
[CmdletBinding()]
param(
    # Defaults to the plugin folder containing this script's parent directory.
    # Overridable so the script can be exercised from a session where
    # $PSScriptRoot is not populated (dot-sourcing, ScriptBlock.Create).
    [string]$PluginRoot,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

if (-not $PluginRoot) {
    if ($PSScriptRoot) {
        $PluginRoot = Join-Path $PSScriptRoot '..'
    }
    elseif ($MyInvocation.MyCommand.Path) {
        $PluginRoot = Join-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) '..'
    }
    else {
        throw "Cannot determine the plugin folder. Pass -PluginRoot explicitly."
    }
}
$root = (Resolve-Path $PluginRoot).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'dist' }
$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "manifest.json not found at $manifestPath" }
# -Encoding UTF8 is explicit on purpose: Windows PowerShell 5.1 defaults to the
# ANSI code page, which mangles the non-ASCII plugin name and breaks JSON parsing.
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

# Runtime allowlist: entry files plus any asset directories that exist.
$runtimeItems = @('manifest.json', 'index.html')
foreach ($optional in @('logo.png', 'js', 'assets', 'images', 'fonts', '_locales', 'modules')) {
    if (Test-Path (Join-Path $root $optional)) { $runtimeItems += $optional }
}

# Verify the manifest's own references actually resolve before packing.
$entry = Join-Path $root $manifest.main.url
if (-not (Test-Path $entry)) { throw "manifest.main.url points at a missing file: $($manifest.main.url)" }
$logo = Join-Path $root ($manifest.logo -replace '^/', '')
if (-not (Test-Path $logo)) { throw "manifest.logo points at a missing file: $($manifest.logo)" }

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("eaglepack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null

try {
    foreach ($item in $runtimeItems) {
        Copy-Item -Path (Join-Path $root $item) -Destination $stage -Recurse -Force
    }

    if (-not (Test-Path $OutputDirectory)) {
        New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    }
    $OutputDirectory = (Resolve-Path $OutputDirectory).Path

    $name = "$($manifest.id)-$($manifest.version).eagleplugin"
    $dest = Join-Path $OutputDirectory $name
    if (Test-Path $dest) { Remove-Item $dest -Force }

    # Build the archive entry by entry instead of using Compress-Archive.
    # On Windows PowerShell, Compress-Archive writes entry names with
    # backslashes ("js\plugin.js"), which violates the ZIP spec; strict
    # extractors then create a file literally named "js\plugin.js" at the
    # root and the plugin installs broken. Writing entries explicitly
    # guarantees forward slashes and lets us verify the layout below.
    Add-Type -AssemblyName System.IO.Compression | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

    $stagedFiles = Get-ChildItem -Path $stage -Recurse -File
    $archive = [System.IO.Compression.ZipFile]::Open($dest, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $stagedFiles) {
            # A wildcard is not used, so paths are relative to the staging root
            # and manifest.json lands at the archive root as Eagle expects.
            $entryName = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
            $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try {
                $source = [System.IO.File]::OpenRead($file.FullName)
                try { $source.CopyTo($entryStream) } finally { $source.Dispose() }
            }
            finally { $entryStream.Dispose() }
        }
    }
    finally { $archive.Dispose() }

    # Verify what was actually written before claiming success.
    $verify = [System.IO.Compression.ZipFile]::OpenRead($dest)
    try {
        $names = @($verify.Entries | ForEach-Object { $_.FullName })
        $bad = @($names | Where-Object { $_ -like '*\*' })
        if ($bad.Count -gt 0) { throw "archive contains non-portable entry names: $($bad -join ', ')" }
        if ($names -notcontains 'manifest.json') { throw "manifest.json is not at the archive root: $($names -join ', ')" }
        if ($names -notcontains $manifest.main.url) { throw "entry file $($manifest.main.url) missing from archive" }
    }
    finally { $verify.Dispose() }

    $size = (Get-Item $dest).Length
    $staged = (Get-ChildItem $stage -Recurse -File | Measure-Object).Count
    Write-Host "packed $staged files -> $dest ($([math]::Round($size / 1KB, 1)) KB)"
    Write-Host "manifest.json is at the archive root; double-click to install, or use Eagle's plugin panel."
}
finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

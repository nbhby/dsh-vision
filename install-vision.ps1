# ============================================================
#  install-vision.ps1 - one-click install/remove of the DIY
#  dsh-vision plugin (global vision_analyze tool, DashScope
#  preset qwen3.8-max, pasted-image support, survives restarts).
#
#  Standardized for distribution: works on any DSH installation,
#  configures the API key automatically (no manual YAML editing).
#
#  Usage (install):
#    powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -ApiKey sk-ws-xxxxx
#    powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1          # prompts for the key
#    powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -Test    # also run a live API smoke test
#  Usage (remove):
#    powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -Remove
#
#  Parameters:
#    -ApiKey     the DASHSCOPE_API_KEY (qianwenai.com, sk-ws-...); auto-detected
#                from env / existing credentials / interactive prompt when omitted
#    -Model      vision model preset (default qwen3.8-max)
#    -BaseUrl    OpenAI-compatible endpoint (default DashScope compatible-mode)
#    -DshHome    DSH home dir (default: $env:DSH_HOME or ~/.dsh)
#    -DshInstall extra dsh installation root for git-clone deployments: the clone
#                directory or its node_modules/@deepseek-ai (auto-detected via
#                the profile's node_modules junctions and PATH in most setups)
#    -Profile    profile name (default: web)
#    -PatchFile  explicit patch file (default: <DshHome>/profiles/<Profile>/cordis.patch.yml)
#    -SkipKey    do not touch the credentials file
#    -SourceUrl  package archive URL for remote one-click installs (defaults to
#                this repository's codeload zip; used only when the dsh-vision
#                folder is not present next to this script)
#    -Test       run the package smoke test (vision-smoke.mjs) after installing
#    -Remove     uninstall (removes package copies + patch row, keeps the key)
#
#  Works with both deployment styles:
#    - npx style:      dsh installed under %LOCALAPPDATA%\npm-cache\_npx\... (auto)
#    - git clone style: dsh cloned anywhere; the store is discovered through the
#      profile node_modules junctions, or given explicitly via -DshInstall
#
#  Remote one-click: irm https://raw.githubusercontent.com/nbhby/dsh-vision/main/install-vision.ps1 | iex
#
#  After install: restart dsh web (close the launcher window, rerun the launcher bat).
# ============================================================
[CmdletBinding()]
param(
    [string]$ApiKey,
    [string]$Model = 'qwen3.8-max',
    [string]$BaseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    [string]$DshHome,
    [string]$DshInstall,
    [string]$Profile = 'web',
    [string]$PatchFile,
    [switch]$SkipKey,
    [string]$SourceUrl = 'https://codeload.github.com/nbhby/dsh-vision/zip/refs/heads/main',
    [switch]$Test,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'dsh-vision'
$rowId = 'vision'

# ---- resolve paths ----
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
if (-not $PatchFile) { $PatchFile = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml" }
$credFile = Join-Path $DshHome '.credentials.yaml'
$profileStore = Join-Path $DshHome "profiles\node_modules\@deepseek-ai"

# The exact patch block this installer owns (matched verbatim on remove).
# ASCII-only comments: PowerShell 5.1 reads/writes this file with the ANSI
# codepage, so non-ASCII text in this block would corrupt the patch file.
$block = @"

# ============================================================
# DIY: vision tools (vision_analyze)
# Gives text-only models image understanding by calling an
# external vision model (default preset: $Model) through an
# OpenAI-compatible endpoint. Pasted images in chat are
# rewritten into analysis hints, so text-only routes never
# crash on image content. API key: DASHSCOPE_API_KEY via the
# credentials seam (env > <DshHome>\.credentials.yaml > .env);
# the installer configures it automatically.
# Source and installer: $PSScriptRoot (install-vision.ps1)
# Remove this row to disable the feature (no other files change).
# ============================================================
- insert:
    - id: vision
      name: '@deepseek-ai/dsh-vision'
      config:
        model: $Model
        baseUrl: '$BaseUrl'
"@

function Write-Step($m) { Write-Host "[diy] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[diy] $m" -ForegroundColor Green }
function Write-Err($m)  { Write-Host "[diy] $m" -ForegroundColor Red }
function Write-Warn($m) { Write-Host "[diy] $m" -ForegroundColor Yellow }

function Get-CredentialEntry {
    param([string]$File, [string]$Ref)
    if (-not (Test-Path $File)) { return $null }
    foreach ($l in Get-Content $File) {
        if ($l -match "^$([regex]::Escape($Ref)):\s*(.*)$") {
            $v = $Matches[1].Trim()
            if ($v -match '^"([^"]*)"$') { return $Matches[1] }
            if ($v -match "^'(.*)'$") { return $Matches[1] }
            return $v
        }
    }
    return $null
}

function Set-CredentialEntry {
    param([string]$File, [string]$Ref, [string]$Value)
    $escaped = $Value -replace '\\', '\' -replace '"', '\"'
    $line = $Ref + ': "' + $escaped + '"'
    $dir = Split-Path $File -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (Test-Path $File) {
        $text = [System.IO.File]::ReadAllText($File)
        if ($text -match "(?m)^$([regex]::Escape($Ref)):.*$") {
            $text = $text -replace "(?m)^$([regex]::Escape($Ref)):.*$", $line
        } else {
            $text = $text.TrimEnd() + "`r`n" + $line + "`r`n"
        }
        [System.IO.File]::WriteAllText($File, $text, (New-Object System.Text.UTF8Encoding($false)))
    } else {
        [System.IO.File]::WriteAllText($File, ($line + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    }
}

function Get-Stores {
    $list = @()
    # 1. npx-style stores under the npm cache
    Get-ChildItem (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx\*\node_modules\@deepseek-ai') -Directory -ErrorAction SilentlyContinue |
        Where-Object {
            (Test-Path (Join-Path $_.FullName 'dsh')) -or (Test-Path (Join-Path $_.FullName 'dsh-base'))
        } |
        ForEach-Object { $list += $_.FullName }
    # 2. profile store for the resolved DshHome
    if (-not (Test-Path $profileStore)) { New-Item -ItemType Directory -Path $profileStore -Force | Out-Null }
    $list += $profileStore
    # 3. git-clone style: the profile node_modules entries are junctions pointing
    #    into the dsh installation (often the clone's node_modules); each unique
    #    junction target parent is an installation store
    Get-ChildItem $profileStore -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkType -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
        ForEach-Object {
            $t = $_.Target
            if ($t) {
                $root = Split-Path $t -Parent
                if ($root -and (Test-Path $root)) { $list += $root }
            }
        }
    # 4. dsh CLI on PATH (npx shim or clone bin): walk up to node_modules/@deepseek-ai
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        $dir = Split-Path $cmd.Source -Parent
        for ($i = 0; $i -lt 8 -and $dir; $i++) {
            $cand = Join-Path $dir 'node_modules\@deepseek-ai'
            if (Test-Path $cand) { $list += $cand; break }
            $parent = Split-Path $dir -Parent
            if ($parent -eq $dir) { break }
            $dir = $parent
        }
    }
    # 5. explicit installation root for git-clone deployments
    if ($DshInstall) {
        $p = $DshInstall
        $nm = Join-Path $p 'node_modules\@deepseek-ai'
        if (Test-Path $nm) { $p = $nm }
        if ((Test-Path $p) -and ((Test-Path (Join-Path $p 'dsh')) -or (Test-Path (Join-Path $p 'dsh-base')))) {
            $list += $p
        } else {
            Write-Warn "-DshInstall does not look like a dsh installation: $DshInstall (expected the clone root or its node_modules/@deepseek-ai)"
        }
    }
    return ($list | Select-Object -Unique)
}

function Test-PluginLoad {
    param([string]$Store)
    $entry = Join-Path $Store 'dsh-vision\lib\index.js'
    if (-not (Test-Path $entry)) { Write-Warn "verification skipped: $entry not found"; return $false }
    $url = 'file:///' + ($entry -replace '\\', '/' -replace ' ', '%20')
    $script = "import('$url').then(m => { if (typeof m.apply !== 'function') process.exit(2); }).catch(() => process.exit(1))"
    & node -e $script 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Ok "module load check passed ($entry)"; return $true }
    Write-Warn "module load check failed (exit $LASTEXITCODE) - check node is on PATH and the package is intact"
    return $false
}

# ---- resolve API key ----
$resolvedKey = ''
if (-not $Remove -and -not $SkipKey) {
    if ($ApiKey) {
        $resolvedKey = $ApiKey
        if (-not $env:DASHSCOPE_API_KEY) { Set-CredentialEntry $credFile 'DASHSCOPE_API_KEY' $ApiKey; Write-Ok "API key written to $credFile" }
        else { Write-Warn 'DASHSCOPE_API_KEY is set in the environment; it shadows the stored key, so the file was not modified' }
    } elseif ($env:DASHSCOPE_API_KEY) {
        $resolvedKey = $env:DASHSCOPE_API_KEY
        Write-Step 'Using DASHSCOPE_API_KEY from the environment'
    } else {
        $existing = Get-CredentialEntry $credFile 'DASHSCOPE_API_KEY'
        if ($existing) { $resolvedKey = $existing; Write-Step "Using existing key from $credFile" }
        else {
            $sec = Read-Host -Prompt 'Paste your DASHSCOPE_API_KEY (sk-ws-... from qianwenai.com)' -AsSecureString
            $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
            try { $resolvedKey = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($bstr) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
            if (-not $resolvedKey) { Write-Err 'No key provided; aborting.'; exit 1 }
            Set-CredentialEntry $credFile 'DASHSCOPE_API_KEY' $resolvedKey
            Write-Ok "API key written to $credFile"
        }
    }
}

# ---- remove ----
if ($Remove) {
    foreach ($store in (Get-Stores)) {
        $target = Join-Path $store 'dsh-vision'
        if (Test-Path $target) { Remove-Item $target -Recurse -Force; Write-Ok "removed $target" }
    }
    if (Test-Path $PatchFile) {
        $patch = Get-Content $PatchFile -Raw
        if ($patch -match [regex]::Escape($block)) {
            $patch = $patch.Replace($block, '')
            $patch = $patch -replace '(?m)^[ \t]*\r?\n{2,}$', "`r`n"
            [System.IO.File]::WriteAllText($PatchFile, $patch, (New-Object System.Text.UTF8Encoding($false)))
            Write-Ok "removed row from $PatchFile"
        } else {
            Write-Step "no vision row found in $PatchFile (skipped)"
        }
    }
    Write-Ok 'Uninstall done. Restart dsh web to apply. (The API key was kept.)'
    exit 0
}

# ---- install ----
if (-not (Test-Path (Join-Path $src 'lib\index.js'))) {
    if (-not $SourceUrl) { Write-Err "source package not found: $src (pass -SourceUrl to download it)"; exit 1 }
    Write-Step "package not found next to this script; downloading from $SourceUrl ..."
    $tmpZip = Join-Path $env:TEMP ('dsh-vision-' + [guid]::NewGuid().ToString('N') + '.zip')
    $tmpDir = Join-Path $env:TEMP ('dsh-vision-' + [guid]::NewGuid().ToString('N'))
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $SourceUrl -OutFile $tmpZip -UseBasicParsing
        Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
    } catch {
        Write-Err "download failed: $($_.Exception.Message)"; exit 1
    }
    $found = Get-ChildItem $tmpDir -Recurse -Directory -Filter 'dsh-vision' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'lib\index.js') } |
        Select-Object -First 1
    if (-not $found) { Write-Err 'downloaded archive does not contain the dsh-vision package'; exit 1 }
    $src = $found.FullName
    Write-Ok "package downloaded and extracted: $src"
}
if (-not (Test-Path $PatchFile)) { Write-Err "patch file not found: $PatchFile (is dsh installed / profile '$Profile' present?)"; exit 1 }

$stores = Get-Stores
if ($stores.Count -eq 0) { Write-Err 'no DSH stores found; is dsh installed?'; exit 1 }

foreach ($store in $stores) {
    $target = Join-Path $store 'dsh-vision'
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Copy-Item $src $target -Recurse -Force
    Write-Ok "installed -> $target"
}

$patch = Get-Content $PatchFile -Raw
if ($patch -match [regex]::Escape($block)) {
    Write-Step "vision row already present in $PatchFile (skipped)"
} else {
    $patch = $patch.TrimEnd() + $block
    [System.IO.File]::WriteAllText($PatchFile, $patch, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "row added to $PatchFile"
}

# ---- verify ----
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
    foreach ($store in $stores) { if (Test-PluginLoad $store) { $nodeOk = $true; break } }
} else {
    Write-Warn 'node not found on PATH; skipped module load check'
}

if ($Test) {
    $smoke = $null
    foreach ($store in $stores) {
        $candidate = Join-Path $store 'dsh-vision\test\vision-smoke.mjs'
        if (Test-Path $candidate) { $smoke = $candidate; break }
    }
    if (-not $smoke) {
        Write-Warn 'smoke test skipped: vision-smoke.mjs not found in package'
    } elseif (-not $resolvedKey) {
        Write-Warn 'smoke test skipped: no API key available (use -ApiKey or configure one first)'
    } else {
        Write-Step 'Running live API smoke test (vision-smoke.mjs) ...'
        $oldKey = $env:DASHSCOPE_API_KEY
        $env:DASHSCOPE_API_KEY = $resolvedKey
        try { & node $smoke; if ($LASTEXITCODE -eq 0) { Write-Ok 'smoke test passed: vision_analyze works end to end' } else { Write-Err "smoke test failed (exit $LASTEXITCODE)" } }
        finally { if ($oldKey) { $env:DASHSCOPE_API_KEY = $oldKey } else { Remove-Item Env:\DASHSCOPE_API_KEY -ErrorAction SilentlyContinue } }
    }
}

Write-Ok "Install done. Restart dsh web to apply (vision_analyze will be global). DshHome=$DshHome Model=$Model"

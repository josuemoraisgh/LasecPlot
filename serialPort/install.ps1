# install.ps1 — build cross-platform dos binários do helper
$ErrorActionPreference = "Stop"
Set-Location -Path (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw "Go não encontrado. Instale com: winget install -e --id GoLang.Go"
}

# garante go.mod
if (-not (Test-Path "./go.mod")) {
  "module lasecplot-helper`n`ngo 1.22" | Set-Content -Encoding UTF8 ./go.mod
}

Write-Host "`n==> go mod tidy"
go mod tidy

$OUT = Join-Path (Get-Location) "..\vscode\bin"
$targets = @(
  @{ GOOS="windows"; GOARCH="amd64"; OUTDIR="win32-x64";   EXT=".exe"  },
  @{ GOOS="windows"; GOARCH="arm64"; OUTDIR="win32-arm64"; EXT=".exe"  },
  @{ GOOS="linux";   GOARCH="amd64"; OUTDIR="linux-x64";   EXT=""      },
  @{ GOOS="linux";   GOARCH="arm64"; OUTDIR="linux-arm64"; EXT=""      },
  @{ GOOS="darwin";  GOARCH="amd64"; OUTDIR="darwin-x64";  EXT=""      },
  @{ GOOS="darwin";  GOARCH="arm64"; OUTDIR="darwin-arm64";EXT=""      }
)

foreach ($t in $targets) {
  New-Item -ItemType Directory -Force -Path (Join-Path $OUT $t.OUTDIR) | Out-Null
}

$env:CGO_ENABLED = "0"

foreach ($t in $targets) {
  $env:GOOS   = $t.GOOS
  $env:GOARCH = $t.GOARCH
  $outFile = Join-Path (Join-Path $OUT $t.OUTDIR) ("lasecplot-helper" + $t.EXT)

  Write-Host ""
  Write-Host "=== Build $($t.GOOS)/$($t.GOARCH) -> $outFile ==="
  go build -trimpath -ldflags "-s -w" -o $outFile .
}

Write-Host "`n[OK] Binários construídos em: $OUT"
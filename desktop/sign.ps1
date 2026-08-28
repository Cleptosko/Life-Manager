# sign.ps1 - Signe les exes Life Manager avec le certificat de signature de code.
# Usage : powershell -ExecutionPolicy Bypass -File sign.ps1 [chemin-exe ...]
# Si aucun chemin n'est donné, signe les artefacts par défaut (app + setup).
# NB : un certificat auto-signé n'est pas reconnu par Windows (avertissement
# "éditeur inconnu"). Pour une vraie signature reconnue, remplacer le PFX par
# un certificat acheté auprès d'une autorité (Sectigo, DigiCert, Certum...).

$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$certDir = Join-Path $root 'cert'
$pfx    = Join-Path $certDir 'life-manager.pfx'
$pwdFile = Join-Path $certDir 'password.txt'

if (-not (Test-Path $pfx) -or -not (Test-Path $pwdFile)) {
    Write-Error "Certificat introuvable. Génère-le d'abord (New-SelfSignedCertificate + Export-PfxCertificate)."
}

$pfxPwd = Get-Content $pwdFile -Raw
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
    $pfx, $pfxPwd,
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
)

# Serveurs d'horodatage (RFC 3161) - on essaie dans l'ordre
$timestamps = @(
    'http://timestamp.digicert.com',
    'http://timestamp.sectigo.com',
    'http://tsa.starfieldtech.com'
)

$targets = if ($args.Count -gt 0) { $args } else {
    @(
        (Join-Path $root 'dist\win-unpacked\Life Manager.exe'),
        (Join-Path $root 'dist\Life-Manager-Setup-1.0.0.exe')
    )
}

foreach ($exe in $targets) {
    if (-not (Test-Path $exe)) { Write-Warning "Introuvable : $exe"; continue }

    # Déjà signé ? on le signe quand même (Set-AuthenticodeSignature remplace)
    $ok = $false
    foreach ($ts in $timestamps) {
        try {
            Set-AuthenticodeSignature -FilePath $exe -Certificate $cert -TimestampServer $ts -HashAlgorithm SHA256 -ErrorAction Stop | Out-Null
            Write-Output "SIGNE : $exe (timestamp: $ts)"
            $ok = $true
            break
        } catch {
            Write-Warning "Timestamp $ts a échoué pour $exe : $($_.Exception.Message)"
        }
    }
    if (-not $ok) {
        # Dernier recours : signature sans horodatage
        Set-AuthenticodeSignature -FilePath $exe -Certificate $cert -HashAlgorithm SHA256 -ErrorAction Stop | Out-Null
        Write-Output "SIGNE (sans timestamp) : $exe"
    }

    $sig = Get-AuthenticodeSignature $exe
    Write-Output ("  Statut : " + $sig.Status)
}

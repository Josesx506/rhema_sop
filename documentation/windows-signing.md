# Windows Installer Signing (Self-Signed, Private Distribution)

Scope: this fork is **not distributed publicly**. Signing exists only to
remove install warnings ("Unknown publisher" / SmartScreen) on the church's
own PC(s). A free self-signed certificate is sufficient because we control
the machines that need to trust it. No Azure, no CA, no renewals (10-year
cert).

## The overall flow (Mac-only development)

1. Develop and test entirely on the Mac (`bun run tauri dev`).
2. Push / tag → GitHub Actions (`.github/workflows/build-release.yml`,
   `windows-latest` runner) builds the Windows installer. **No toolchain is
   ever installed on the church PC** — it only receives the finished
   installer.
3. Download the unsigned installer artifact to the Mac.
4. Sign it on the Mac with `osslsigncode` (steps below). The private key
   never leaves the Mac and is never stored in GitHub.
5. Copy the signed installer to the church PC (USB). USB copies carry no
   Mark-of-the-Web, and the trusted signature removes the publisher prompt.

## One-time: generate the certificate (on the Mac)

```bash
# 1. Self-signed code-signing cert, valid 10 years.
#    The codeSigning EKU is REQUIRED for Windows Authenticode.
openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
  -keyout sop-signing.key -out sop-signing.crt \
  -subj "/CN=Streams Of Praise" \
  -addext "extendedKeyUsage=codeSigning" \
  -addext "keyUsage=digitalSignature"

# 2. Bundle key + cert into a password-protected PFX (the signing secret).
#    Choose a strong password; you'll enter it at each signing.
openssl pkcs12 -export -inkey sop-signing.key -in sop-signing.crt \
  -out sop-signing.pfx

# 3. Public-cert-only file in DER form — this is what the church PC trusts.
openssl x509 -in sop-signing.crt -outform DER -out sop-signing.cer

# 4. Delete the loose private key; the PFX is the canonical secret.
rm sop-signing.key
```

Storage: keep `sop-signing.pfx` + its password in a password manager (and
optionally one offline USB backup). **Never commit it.** Anyone holding the
PFX can sign software the church PC will trust. `sop-signing.cer` is public
and safe to share/copy freely.

Alternative generation on any Windows machine (equivalent result), if ever
preferred:

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=Streams Of Praise" `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(10)
Export-PfxCertificate -Cert $cert -FilePath sop-signing.pfx `
  -Password (Read-Host -AsSecureString "PFX password")
Export-Certificate -Cert $cert -FilePath sop-signing.cer
```

## One-time: trust the certificate on the church PC

Copy `sop-signing.cer` to the PC, then for **each** of the two stores:

1. Double-click `sop-signing.cer` → **Install Certificate…**
2. Store location: **Local Machine** (needs admin).
3. "Place all certificates in the following store" → **Browse…**
   - First pass: **Trusted Root Certification Authorities**
     (makes the certificate chain valid)
   - Second pass: **Trusted Publishers**
     (suppresses the unknown-publisher prompt)

That's it — every installer signed with this cert now installs cleanly on
that machine. A new/replacement PC just repeats this two-minute import.

## Each release: sign the installer on the Mac

```bash
brew install osslsigncode        # once

osslsigncode sign \
  -pkcs12 sop-signing.pfx \
  -askpass \
  -n "Rhema SOP" \
  -h sha256 \
  -in  Rhema-windows-x64-setup.exe \
  -out Rhema-windows-x64-setup-signed.exe

# Optional sanity check:
osslsigncode verify Rhema-windows-x64-setup-signed.exe
```

Notes:
- Signing the **installer** is sufficient for the install-time UX. The app
  binary inside runs without warnings once installed (no Mark-of-the-Web on
  locally installed files). If inner-exe signing is ever wanted, the same
  command signs `rhema.exe` before packaging — but that requires signing in
  CI instead (see below).
- Timestamping (`-ts`) is unnecessary here: with a self-signed 10-year cert
  there is no reputation or expiry story worth preserving.

## Alternative: sign in CI instead (not chosen)

If hand-signing each release ever becomes a chore: base64-encode the PFX
into a GitHub Actions secret, import it on the `windows-latest` runner, and
set `bundle.windows` signing config (`certificateThumbprint` or
`signCommand`) in `src-tauri/tauri.conf.json` — Tauri then signs the app
exe **and** installers automatically during bundling. Trade-off: the
private key lives in GitHub secrets. Swapping later to a public CA / Azure
Artifact Signing (if the app ever distributes publicly — see todo.md) is a
config change in the same hook.

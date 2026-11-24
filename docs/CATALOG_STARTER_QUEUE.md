# APPNEST — Starter Content Queue

Status: research queue only. Nothing in this file is published or downloadable yet. Do not create public app rows until each candidate passes source, version, license, package, permissions, and APK-hash checks.

## Editorial rules
- First wave should favor useful, reputable Android apps with an official publisher download page and clear licensing.
- Prefer open-source/free software for the initial catalogue because provenance and distribution permissions are easier to audit.
- The source URL below is a starting point for metadata verification, not an approved APK mirror or proof that redistribution is allowed.
- Record the exact APK artifact, package ID, versionCode, Android minimum, file size, SHA-256, publisher, license, icon/screenshot attribution, and verification date.
- If an official page only links to Google Play and does not authorize direct APK redistribution, link to the official store or obtain explicit permission; do not re-host the APK.

## Candidate queue
| Priority | Candidate | Category | Official source for verification | Gate before publishing |
|---|---|---|---|---|
| 1 | VLC for Android | Tools | https://www.videolan.org/vlc/download-android.html | Confirm current release, package ID, artifact signature, license and redistribution terms. |
| 2 | Firefox for Android | Tools | https://www.mozilla.org/firefox/android/ | Verify official APK availability, signing, version and distribution terms. |
| 3 | Signal | Communication / Other | https://signal.org/android/apk/ | Verify official signing instructions, current version and redistribution permission. |
| 4 | Telegram | Communication / Other | https://telegram.org/android | Confirm official direct APK source, package, signature and terms. |
| 5 | Organic Maps | Tools | https://organicmaps.app/ | Verify release artifact, package, license, signature and attribution. |
| 6 | AntennaPod | Productivity | https://antennapod.org/ | Verify official release, package, license, version and screenshots. |
| 7 | KDE Connect | Tools | https://kdeconnect.kde.org/ | Verify Android artifact source, package, license and release status. |
| 8 | Aegis Authenticator | Tools | https://github.com/beemdevelopment/Aegis | Verify official release artifact, signing, license and package metadata. |
| 9 | Material Files | Tools | https://github.com/zhanghai/MaterialFiles | Verify official release artifact, package, license and release metadata. |
| 10 | NewPipe | Tools | https://github.com/TeamNewPipe/NewPipe | Verify current project status, release artifact, signing, package and policy suitability. |
| 11 | F-Droid | Tools | https://f-droid.org/ | Verify official APK, signing, repository model and clear user-facing explanation. |
| 12 | Proton VPN | Tools | https://protonvpn.com/download-android | Verify free-tier details, official artifact availability and redistribution permission. |

## Per-app intake record
Use one record per candidate with these fields:
```json
{
  "name": "",
  "developer": "",
  "category": "tools|productivity|games|other",
  "short_description": "",
  "description": "",
  "package_id": "",
  "version": "",
  "version_code": 0,
  "min_android": "",
  "size_bytes": 0,
  "official_source_url": "",
  "artifact_source_url": "",
  "license": "",
  "redistribution_permission": "unknown|allowed|not_allowed|permission_required",
  "sha256": "",
  "icon_source": "",
  "screenshots": [],
  "review_status": "candidate",
  "verified_at": null,
  "review_notes": []
}
```

## First editorial batch
1. Verify VLC, Organic Maps, AntennaPod and Aegis first; these are strong initial candidates for a utility-focused catalogue.
2. Complete metadata and artwork attribution before uploading anything.
3. Verify binary provenance and redistribution rights separately from metadata.
4. Publish only reviewed records. If a binary cannot legally or safely be re-hosted, show the official publisher link instead of an APPNEST download button.

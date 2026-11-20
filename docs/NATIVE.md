# Native delivery architecture (Tauri) — #28

Decision record plus platform capability matrices for shipping fern-matrix
beyond the browser/PWA. Packaging work itself lives in #29 (desktop),
#30 (mobile) and #31 (PWA hardening).

## Shell options evaluated

| Option | Vue/Frappe UI reuse | Matrix SDK reuse | Background execution | Store signing | Binary size | Verdict |
|---|---|---|---|---|---|---|
| **Tauri 2** | Full (system webview) | Full (same WASM bundle) | Desktop: free; mobile: OS-limited | Desktop + mobile signing supported | ~10 MB + webview | **Chosen** |
| Capacitor 7 | Full (system webview) | Full (same WASM bundle) | Mobile background limits apply equally | Mobile signing supported | Similar | Runner-up; revisit if Tauri mobile stalls |
| Electron | Full (bundled Chromium) | Full | Desktop: free | Desktop signing supported | ~150 MB+ | Rejected: bundle size, no mobile story |
| PWA only | n/a | n/a | No iOS push, limited Android | n/a | n/a | Kept as baseline (#31), not the native answer |
| React Native / native SDK | Rewrite UI, lose Frappe | Native rust-sdk bindings (uniffi) | Best background story | Full | Small | Rejected: full rewrite, no Frappe UI reuse |

Evaluation criteria were SDK binding reuse, Frappe UI reuse, background
execution, platform restrictions, updates and signing.

## Architecture decision

- Ship native shells with **Tauri 2**, one `src-tauri/` shell for desktop
  first (Linux/Windows/macOS) and Android/iOS second (#30).
- Reuse the **same Vite build and the same pinned WASM SDK bundle** inside
  the webview — no native rust-sdk bindings, no second crypto implementation.
  Session/crypto persistence stays in the existing store; secrets move from
  `localStorage` to OS secure storage (see below).
- Secure storage: OS keychain/keystore via the Tauri secure-storage plugin
  surface (`tauri-plugin-keyring`-class API). Web `CryptoKey` non-extractable
  keys do not survive webview data clears, so the refresh/access tokens and
  the crypto-store passphrase live in secure storage; the encrypted payloads
  stay in the app data dir.
- OIDC/login: deep-link custom scheme (`fernmatrix://`) handled by the shell
  and forwarded to the existing redirect-restoration path (#11).
- Background: desktop keeps the existing sync loop with OS autostart; mobile
  is OS-limited (no Matrix background sync on iOS, Android via FCM + gateway
  — same constraint as #24, documented in `docs/PUSH.md`).
- Updates: Tauri updater (signed artifacts) on desktop; store updates on
  mobile. Signing keys stay out of the repo; CI (#29/#30) holds them.
  Wired: `tauri-plugin-updater` + `plugin-process` (check/download/install/
  relaunch), `updater:default` + `process:default` capabilities, pubkey and
  `latest.json` endpoint in `tauri.conf.json`, in-app Check/Install row in
  Settings > Appearance (shell only, inert in browsers), and a tag-gated
  `linux-release` CI job (`refs/tags/v*` + `TAURI_SIGNING_PRIVATE_KEY`
  secret) that builds signed deb/AppImage/updater bundles, composes
  `latest.json` via `scripts/compose-updater.mjs` (fails on tag/version
  drift or missing signatures), and publishes the GitHub release the
  updater polls. Testing signing is live: a minisign keypair with the public
  key in `tauri.conf.json` and the private key as the
  `TAURI_SIGNING_PRIVATE_KEY` repo secret; `v0.1.0` was cut with
  `node scripts/cut-release.mjs 0.1.0`, which sync-checks `package.json`,
  `tauri.conf.json` and `Cargo.toml` before pushing the tag. Rotate all
  testing keys and secrets before any production release.
- Permissions (camera/mic/location per call/voice/location features) are
  requested by the shell at first use with the existing in-app rationale UI.

## Prototype evidence

- `src-tauri/` holds the minimal desktop shell: `tauri.conf.json` serving the
  Vite `dist/` bundle, `main.rs`, base capability set, generated `icons/`.
- `cargo build` on Linux (system webkit2gtk, Tauri 2) links cleanly into
  `src-tauri/target/debug/fern-matrix` after generating the missing app icons
  (`generate_context!` fails the compile without `icons/icon.png` — fixed by
  committing a generated fern-mark set).
- The binary launches under Xvfb, stays resident 18s+ with no crash, panic or
  error output. Headless screenshots stay black (no GPU for webkit
  compositing, even with `WEBKIT_DISABLE_COMPOSITING_MODE=1`), so in-webview
  rendering of `dist/` is **not** proven here — it moves to #29 on real
  hardware alongside installer signing.
- Android builds in CI (`.github/workflows/mobile.yml`): debug APK on every
  PR/main, signed release APK plus AAB on version tags and manual dispatch.
  The Tauri CLI ships no release-signing wiring, so the release job signs
  post-build (zipalign plus apksigner for the APK, jarsigner for the AAB,
  verified in-step) with the upload keystore from CI secrets
  (`ANDROID_KEYSTORE_BASE64/PASSWORD`, `ANDROID_KEY_PASSWORD`,
  `ANDROID_KEY_ALIAS`). The signing flow is proven end to end on a manual
  dispatch with signatures verified against the testing upload key; the
  `v0.1.0` tag runs the same jobs. Mobile lifecycle and background work stay
  with #30.
- Android launcher icons are re-rendered from `src-tauri/icons/icon.png` by
  `scripts/sync_android_icons.py` (the scaffolded Tauri robot art is fully
  replaced, including adaptive `mipmap-anydpi-v26` definitions); CI runs the
  script after every `android init` (the generated `gen/android` tree is
  gitignored, so there is nothing to commit — just re-check the APK icon
  after any icon source change).
- Edge-to-edge Android webviews are handled in CSS: `.app-shell` and the
  fullscreen mobile details panel pad `env(safe-area-inset-top)` so content
  clears the status bar (bottom insets were already on the composer and
  sidebar footer).
- Session secrets (crypto-store passphrase plus Matrix access/refresh
  tokens) moved out of `localStorage` into `src/secrets.ts`: OS keychain via
  `secret_get/set/delete` shell commands (`keyring` crate: Secret
  Service/Keychain/Credential Manager) inside Tauri, isolated localStorage
  fallback in browsers, memory cache for the sync SDK session delegate, and
  a safe legacy-record adoption (record rewrite only after the secrets
  persist). Bridge plus fallback plus migration covered by unit tests; shell
  `cargo check` clean (keyring + updater + process). A live-shell keychain
  round trip on real hardware,
  WASM crypto init inside the webview and deep-link restore stay acceptance
  items on #29/#30 before packaging is declared done.

## Capability matrix (target state)

| Capability | Linux desktop | Windows/macOS desktop | Android | iOS |
|---|---|---|---|---|
| App shell | Tauri (#29) | Tauri (#29) | Tauri mobile (#30) | Tauri mobile (#30) |
| WASM SDK reuse | Yes (prototype) | Expected same | Expected same | Expected same |
| Secure token storage | Secret Service/keychain | DPAPI/keychain | Keystore | Keychain |
| OIDC deep link | Custom scheme | Custom scheme | App link | Universal link |
| Background sync | Autostart loop | Autostart loop | FCM + gateway (#24) | N/A (OS-limited) |
| RTC calls | System WebRTC | System WebRTC | System WebRTC | System WebRTC |
| Auto updates | Tauri updater | Tauri updater + signing | Play/store | App Store |

## Follow-ups

- #29 — signed desktop builds + secure storage + deep links + updater.
- #30 — mobile builds (Tauri Android APK first), lifecycle + background.
- #31 — PWA install/update/compat baseline stays.
- #25/#24 — RTC media and push-gateway results feed the mobile matrix.

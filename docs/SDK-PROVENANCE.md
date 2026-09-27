# Rust SDK artifacts

- Artifact source: https://github.com/element-hq/aurora
- Aurora commit: `95e69fc560e31ea263f3e4d45fb9125557f49ace` (2026-06-10)
- Rust source repository: https://github.com/matrix-org/matrix-rust-sdk
- Rust commit configured by that Aurora checkout: `73449f4f57e4185c95ee69cf9f3e41d9a0e0857e`
- Rust manifest: `bindings/matrix-sdk-ffi/Cargo.toml`; generated web workspace manifest: `bindings/wasm/Cargo.toml`
- Web features: `native-tls`, `js`, `indexeddb`; default features disabled
- UniFFI runtime: npm `uniffi-bindgen-react-native@0.29.3-1`
- Generator configured by Aurora: `jhugman/uniffi-bindgen-react-native` commit `5c01f3f7025d069aac1dd1fd51ca72bb76fdb243`. This configured generator is distinct from Fern's published runtime package; a clean generation/build has not yet been verified.
- WASM SHA256: `f568fe056beb5ef29b9d401e0cd9748a345c3498165d2d1c7dc1e1e6fa2558e2`

This app uses the artifacts from that specific checkout, not the latest Rust SDK release. A release upgrade requires regenerating and testing the bindings and WASM together. The original Aurora experiment is experimental; this application's reuse does not establish production readiness.

`scripts/sdk-lock.json` records all generated bindings, WASM glue, WASM, initialization wrapper and license notice sizes/SHA256 hashes, plus the configured upstream sources and downgrade-patch hash. `npm run sdk:verify` checks the exact file set, contents and runtime package/lock version. Pages and live integration CI run this check. It detects mismatched or incomplete updates; it is not independent binary attestation or proof of reproducible compilation.

Issue [#5](https://github.com/hanthor/fern-matrix/issues/5) remains open for clean source regeneration, pinned build tools and build-dependency lockfiles, upgrade/rollback procedures and rebuild evidence. The current lock describes audited vendored artifacts; do not update its hashes merely to silence a failure. Review new source pins and generated changes, run live/browser interoperability checks, then intentionally refresh the lock as part of the upgrade.

## Files and changes

`src/sdk/generated/` is copied from Aurora's `src/generated/`. `src/sdk/index.ts` is Aurora's initialization and re-export module, renamed from `src/index.web.ts`. The initialization WASM import includes `?url` for Vite asset handling.

Compatibility patch in generated TypeScript: replace `async public ` with `public async `. Current esbuild rejects the original modifier order. This does not alter the WASM or API signatures.

Aurora's AGPL license text is included as `LICENSE.txt`. Original generated and initialization file comments are retained. The npm runtime has its own MPL-2.0 license. No upstream application view models or UI components are copied.

## Rebuild from Rust

Use a separate checkout so Aurora's regeneration script cannot reset application work:

```sh
git clone https://github.com/element-hq/aurora.git /tmp/fern-sdk-source
git -C /tmp/fern-sdk-source checkout 95e69fc560e31ea263f3e4d45fb9125557f49ace
```

Install the upstream prerequisites (`cargo`, `wasm-bindgen-cli`, Yarn and Binaryen's `wasm-opt`), then run Aurora's `build-wasm-bindings.sh` inside that checkout. Its script installs the configured Rust source, applies its UniFFI downgrade patch, generates a wasm workspace, builds and optimizes the WASM. Review that script before running it; it resets its own SDK checkout during regeneration.

From this application's directory:

```sh
node scripts/vendor-sdk.mjs /tmp/fern-sdk-source
npm run build
npm run test:e2e
```

The copy script reapplies the modifier patch. Update this provenance document with the new commits and printed checksum. New bindings may require changing `src/sdk/engine.ts`. Actual regeneration was not performed in the initial implementation; the checked-in upstream binary was verified to initialize in Chromium.

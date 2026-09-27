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

`scripts/sdk-lock.json` records all generated bindings, WASM glue, WASM, initialization wrapper and license notice sizes/SHA256 hashes, plus the configured upstream sources and downgrade-patch hash. `npm run sdk:verify` checks the exact file set, contents and runtime package/lock version. Pages and live integration CI run this check. It detects mismatched or incomplete updates; it is not independent binary attestation.

Issue [#5](https://github.com/hanthor/fern-matrix/issues/5) tracks source regeneration and rollback evidence. The current lock describes audited vendored artifacts; do not update its hashes merely to silence a failure. Review new source pins and generated changes, run live/browser interoperability checks, then intentionally refresh the lock as part of an SDK upgrade.

## Files and changes

`src/sdk/generated/` is copied from Aurora's `src/generated/`. `src/sdk/index.ts` is Aurora's initialization and re-export module, renamed from `src/index.web.ts`. The initialization WASM import includes `?url` for Vite asset handling.

Compatibility patch in generated TypeScript: replace `async public ` with `public async `. Current esbuild rejects the original modifier order. This does not alter the WASM or API signatures.

Aurora's AGPL license text is included as `LICENSE.txt`. Original generated and initialization file comments are retained. The npm runtime has its own MPL-2.0 license. No upstream application view models or UI components are copied.

## Rebuild from Rust

Run the **Reproducible Rust SDK rebuild** GitHub Actions workflow manually. It uses Ubuntu 24.04, Node 24.14.0, Yarn 1.22.22, Rust 1.94.1, `wasm-bindgen-cli` 0.2.105 and Binaryen 123. It checks out Aurora, Rust SDK and generator at the commits above, verifies the UniFFI patch checksum, and uses only disposable source directories under the runner temp path. Both clean builds must produce identical generated file sets and SHA256 hashes; the workflow then compiles Fern against the second output. The workflow does not publish or commit generated files.

The first run bootstraps `Cargo.lock` from the pinned source graph and uses that output as the lock for the second clean build. Download the workflow artifact and review both `build-info.json` files, generated bindings/API changes, the optimized WASM checksum and `sdk-build.Cargo.lock`. Commit the candidate lock as `scripts/sdk-build.Cargo.lock`, rerun the workflow, and require a passing build using that committed lock before adopting the artifacts.

To adopt a candidate, copy `src/sdk/` and `LICENSE.txt` from the artifact, inspect the complete diff, update the artifact checksums and source/tool metadata in `scripts/sdk-lock.json`, and update this provenance record. Run `npm run sdk:verify`, the browser and live Matrix integration checks, and the production build before merging. A new binding surface may require changes to `src/sdk/engine.ts` and UI services. Do not replace the currently locked artifacts until the source rebuild and compatibility checks pass.

To roll back, revert the single adoption commit; it restores the prior bindings, WASM, provenance and hashes together. The previous verified binaries remain in Git history and the published build is not changed by the rebuild workflow itself.

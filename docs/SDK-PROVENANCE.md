# Rust SDK artifacts

- Artifact source: https://github.com/element-hq/aurora
- Aurora commit: `95e69fc560e31ea263f3e4d45fb9125557f49ace` (2026-06-10)
- Rust source repository: https://github.com/matrix-org/matrix-rust-sdk
- Rust commit configured by that Aurora checkout: `73449f4f57e4185c95ee69cf9f3e41d9a0e0857e`
- Rust manifest: `bindings/matrix-sdk-ffi/Cargo.toml`; generated web workspace manifest: `bindings/wasm/Cargo.toml`
- Web features: `native-tls`, `js`, `indexeddb`; default features disabled
- UniFFI runtime: npm `uniffi-bindgen-react-native@0.29.3-1`
- Generator configured by Aurora: `jhugman/uniffi-bindgen-react-native` commit `5c01f3f7025d069aac1dd1fd51ca72bb76fdb243`. This configured generator is distinct from Fern's published runtime package.
- WASM SHA256: `f568fe056beb5ef29b9d401e0cd9748a345c3498165d2d1c7dc1e1e6fa2558e2`

This app uses the artifacts from that specific checkout, not the latest Rust SDK release. A release upgrade requires regenerating and testing the bindings and WASM together. The original Aurora experiment is experimental; this application's reuse does not establish production readiness.

`scripts/sdk-lock.json` records all generated bindings, WASM glue, WASM, initialization wrapper and license notice sizes/SHA256 hashes, plus the configured upstream sources and downgrade-patch hash. `npm run sdk:verify` checks the exact file set, contents and runtime package/lock version. Pages and live integration CI run this check. It detects mismatched or incomplete updates; it is not independent binary attestation.

A pair of isolated clean source builds completed from the pins below with identical Cargo locks, UniFFI TypeScript bindings, and stable WASM glue. The Rust/WASM toolchain assigns different internal `wasm_bindgen__convert__closures` and `wasm_bindgen__closure__destroy` exports between builds, so the WASM bytes and those generated closure glue sections are not bit-for-bit reproducible. The rebuild comparator permits only those identified sections to vary, requires every other staged SDK file and byte count to match, records each candidate hash, then compiles Fern and runs the live Synapse/Chromium suite against the second candidate. This verifies the source/API boundary and the candidate used by CI; it does not claim identical WASM bytes across independent compiler processes.

Issue [#5](https://github.com/hanthor/fern-matrix/issues/5) tracks source regeneration and rollback evidence. The current lock describes audited vendored artifacts; do not update its hashes merely to silence a failure. Review new source pins and generated changes, run live/browser interoperability checks, then intentionally refresh the lock as part of an SDK upgrade.

## Files and changes

`src/sdk/generated/` is copied from Aurora's `src/generated/`. `src/sdk/index.ts` is Aurora's initialization and re-export module, renamed from `src/index.web.ts`. The initialization WASM import includes `?url` for Vite asset handling.

Compatibility patch in generated TypeScript: replace `async public ` with `public async `. Current esbuild rejects the original modifier order. This does not alter the WASM or API signatures.

Aurora's AGPL license text is included as `LICENSE.txt`. Original generated and initialization file comments are retained. The npm runtime has its own MPL-2.0 license. No upstream application view models or UI components are copied.

## Rebuild from Rust

Run the **Reproducible Rust SDK rebuild** GitHub Actions workflow manually. It uses Ubuntu 24.04, Node 24.14.0, Yarn 1.22.22, Rust 1.94.1, `wasm-bindgen-cli` 0.2.105 and Binaryen 123. It checks out Aurora, Rust SDK and generator at the commits above, verifies both compatibility-patch checksums, and uses only disposable source directories under the runner temp path. The Rust SDK patch raises the `matrix-sdk` crate's recursion limit to 256 because Rust 1.94.1 otherwise rejects its `sync()` future at the compiler's default depth. UBRN's first pass generates bindings and the WASM crate without compiling the WASM; the second pass compiles it after adding that crate to the SDK workspace. Both clean builds must produce identical generated file sets, stable bindings/glue, byte counts and final lock bytes. Only the Rust-generated WASM closure export section and WASM binary may vary; each candidate's SHA256 remains recorded in its build metadata. The workflow then compiles Fern and runs the live Synapse/Chromium integration suite against the second candidate. It does not publish or commit generated files.

The initial run bootstrapped `Cargo.lock` from the pinned source graph; the resolved lock is committed as `scripts/sdk-build.Cargo.lock`. Later runs may fetch the exact registry and Git revisions listed in that lock, then require each final lock to match it byte-for-byte. The full lock is restored between UBRN's generate-only pass and the WASM build so Cargo retains the resolved versions while the workspace member is toggled. Download the workflow artifact and review both `build-info.json` files, generated bindings/API changes and the optimized WASM checksum before adopting the artifacts.

To adopt a candidate, copy `src/sdk/` and `LICENSE.txt` from the artifact, inspect the complete diff, update the artifact checksums and source/tool metadata in `scripts/sdk-lock.json`, and update this provenance record. Run `npm run sdk:verify`, the browser and live Matrix integration checks, and the production build before merging. A new binding surface may require changes to `src/sdk/engine.ts` and UI services. Do not replace the currently locked artifacts until the source rebuild and compatibility checks pass.

To roll back, revert the single adoption commit; it restores the prior bindings, WASM, provenance and hashes together. The previous verified binaries remain in Git history and the published build is not changed by the rebuild workflow itself.

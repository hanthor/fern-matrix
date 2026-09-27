#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fern-sdk-rebuild-${GITHUB_RUN_ID:-local}-$$"
tool_root="$scratch_root/tools"
aurora_dir="$scratch_root/aurora"
candidate_root="${SDK_CANDIDATE_DIR:-$repo_root/.sdk-candidates}"
aurora_commit=95e69fc560e31ea263f3e4d45fb9125557f49ace
rust_commit=73449f4f57e4185c95ee69cf9f3e41d9a0e0857e
generator_commit=5c01f3f7025d069aac1dd1fd51ca72bb76fdb243
patch_sha=9f4b92319568dc0d6fa783a342eeff0ac7735be28fe86ed3a0e4f7a756c8bb38
rust_build_patch_sha=ccae395e4877bb1864eeb2abbc9611df66c9533318ecba943133ea157e7de37c

mkdir -p "$scratch_root" "$tool_root" "$candidate_root"
cleanup() { rm -rf -- "$scratch_root"; }
trap cleanup EXIT

fail() { printf 'SDK rebuild failed: %s\n' "$*" >&2; exit 1; }
[[ "$(node --version)" == "v24.14.0" ]] || fail "Expected Node v24.14.0, got $(node --version)"
npm install --global yarn@1.22.22
[[ "$(yarn --version)" == "1.22.22" ]] || fail "Expected Yarn 1.22.22"
rustup toolchain install 1.94.1 --profile minimal --component rustfmt
rustup target add wasm32-unknown-unknown --toolchain 1.94.1
rustup default 1.94.1
[[ "$(rustc --version | awk '{print $2}')" == "1.94.1" ]] || fail "Rust toolchain version mismatch"
cargo install wasm-bindgen-cli --version 0.2.105 --locked
[[ "$(wasm-bindgen --version)" == "wasm-bindgen 0.2.105" ]] || fail "wasm-bindgen version mismatch"

tools=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync("scripts/sdk-lock.json", "utf8")).rebuildTools.binaryen))')
binaryen_url=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).url)' "$tools")
binaryen_sha=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sha256)' "$tools")
curl --fail --location --retry 3 "$binaryen_url" --output "$scratch_root/binaryen.tar.gz"
printf '%s  %s\n' "$binaryen_sha" "$scratch_root/binaryen.tar.gz" | sha256sum --check --status || fail "Binaryen archive checksum mismatch"
tar -xzf "$scratch_root/binaryen.tar.gz" -C "$tool_root"
binaryen_dir=$(find "$tool_root" -mindepth 1 -maxdepth 1 -type d -name 'binaryen-version_123*' -print -quit)
[[ -n "$binaryen_dir" ]] || fail "Binaryen archive has no expected directory"
export PATH="$(rustc --print sysroot)/bin:$binaryen_dir/bin:$PATH"
[[ "$(wasm-opt --version)" == *"123"* ]] || fail "Binaryen version mismatch: $(wasm-opt --version)"

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export CARGO_INCREMENTAL=0
export CARGO_BUILD_JOBS=2
export FERN_YARN_VERSION="$(yarn --version)"
export FERN_RUSTC_VERSION="$(rustc --version)"
export FERN_CARGO_VERSION="$(cargo --version)"
committed_lock="$repo_root/scripts/sdk-build.Cargo.lock"
bootstrap_lock="$scratch_root/bootstrap.Cargo.lock"

prepare_aurora() {
  rm -rf -- "$aurora_dir"
  git clone --filter=blob:none --no-checkout https://github.com/element-hq/aurora.git "$aurora_dir"
  git -C "$aurora_dir" checkout --detach "$aurora_commit"
  [[ "$(git -C "$aurora_dir" rev-parse HEAD)" == "$aurora_commit" ]] || fail "Aurora source commit mismatch"
  yarn --cwd "$aurora_dir" install --frozen-lockfile --non-interactive
  yarn --cwd "$aurora_dir" ubrn:clean
  yarn --cwd "$aurora_dir" ubrn:checkout

  sdk="$aurora_dir/rust_modules/matrix-rust-sdk"
  [[ -d "$sdk/.git" ]] || fail "UBRN checkout did not create the configured Matrix Rust SDK"
  [[ "$(git -C "$sdk" rev-parse HEAD)" == "$rust_commit" ]] || fail "Matrix Rust SDK source commit mismatch"
  generator="$aurora_dir/node_modules/uniffi-bindgen-react-native"
  grep -Fq -- "uniffi-bindgen-react-native#${generator_commit}" "$aurora_dir/yarn.lock" || fail "Frozen Yarn lock does not pin the configured UniFFI generator commit"
  [[ -f "$generator/crates/ubrn_cli/Cargo.toml" ]] || fail "The pinned Yarn install has no UniFFI generator CLI manifest"
  patch="$aurora_dir/patches/0001-Downgrade-uniffi-to-0.29.4.patch"
  printf '%s  %s\n' "$patch_sha" "$patch" | sha256sum --check --status || fail "UniFFI compatibility patch changed"
  git -C "$sdk" apply --check "$patch"
  git -C "$sdk" apply "$patch"
  rust_build_patch="$repo_root/patches/matrix-sdk-recursion-limit.patch"
  printf '%s  %s\n' "$rust_build_patch_sha" "$rust_build_patch" | sha256sum --check --status || fail "Rust recursion-limit compatibility patch changed"
  git -C "$sdk" apply --check "$rust_build_patch"
  git -C "$sdk" apply "$rust_build_patch"
  python3 "$repo_root/scripts/set-sdk-workspace-member.py" "$sdk/Cargo.toml"
  if [[ -f "$committed_lock" ]]; then
    cp "$committed_lock" "$sdk/Cargo.lock"
  elif [[ -f "$bootstrap_lock" ]]; then
    cp "$bootstrap_lock" "$sdk/Cargo.lock"
  fi
}

build_one() {
  local repetition="$1"
  local source_lock
  export CARGO_TARGET_DIR="$scratch_root/cargo-target-$repetition"
  prepare_aurora
  if [[ -f "$committed_lock" || "$repetition" == 2 ]]; then
    # Cargo is kept offline and locked once a lockfile exists. The generated lock
    # from pass one bootstraps pass two until it is committed for future runs.
    mkdir -p "$scratch_root/cargo-shim"
    export FERN_REAL_CARGO="$(rustup which --toolchain 1.94.1 cargo)"
    cat > "$scratch_root/cargo-shim/cargo" <<'SHIM'
#!/usr/bin/env bash
exec "$FERN_REAL_CARGO" --locked "$@"
SHIM
    chmod +x "$scratch_root/cargo-shim/cargo"
    export PATH="$scratch_root/cargo-shim:$PATH"
    export CARGO_NET_OFFLINE=true
  else
    export CARGO_NET_OFFLINE=false
  fi

  yarn --cwd "$aurora_dir" ubrn:web:build:release
  python3 "$repo_root/scripts/set-sdk-workspace-member.py" "$aurora_dir/rust_modules/matrix-rust-sdk/Cargo.toml" --enable
  yarn --cwd "$aurora_dir" ubrn:web:build:release
  local wasm="$aurora_dir/src/generated/wasm-bindgen/index_bg.wasm"
  [[ -s "$wasm" ]] || fail "The generator did not produce its expected WASM binary"
  wasm-opt -Oz "$wasm" -o "$wasm.optimized"
  mv -- "$wasm.optimized" "$wasm"
  source_lock="$aurora_dir/rust_modules/matrix-rust-sdk/Cargo.lock"
  [[ -s "$source_lock" ]] || fail "The SDK build did not produce Cargo.lock"
  if [[ "$repetition" == 1 && ! -f "$committed_lock" ]]; then cp "$source_lock" "$bootstrap_lock"; fi
  rm -rf -- "$candidate_root/build-$repetition"
  node "$repo_root/scripts/stage-sdk-artifacts.mjs" "$aurora_dir" "$candidate_root/build-$repetition" "$repetition"
  rm -rf -- "$scratch_root/cargo-shim"
  export PATH="${PATH#"$scratch_root/cargo-shim:"}"
  unset FERN_REAL_CARGO
  unset CARGO_NET_OFFLINE
}

build_one 1
rm -rf -- "$scratch_root/cargo-target-1"
build_one 2
node "$repo_root/scripts/compare-sdk-builds.mjs" "$candidate_root/build-1" "$candidate_root/build-2"
cp "$candidate_root/build-2/Cargo.lock" "$candidate_root/sdk-build.Cargo.lock"
printf 'Reproducible SDK candidates are ready in %s\n' "$candidate_root" 

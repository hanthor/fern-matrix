"""Toggle the temporary generated WASM crate in Aurora's disposable SDK clone."""
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("cargo_toml", type=Path)
parser.add_argument("--enable", action="store_true")
args = parser.parse_args()
path = args.cargo_toml.resolve(strict=True)
if path.name != "Cargo.toml" or path.parent.name != "matrix-rust-sdk" or path.parent.parent.name != "rust_modules":
    raise SystemExit("Refusing to edit anything except rust_modules/matrix-rust-sdk/Cargo.toml in a scratch checkout")
content = path.read_text()
entry = '    "bindings/wasm",\n'
present = content.count(entry)
if present > 1:
    raise SystemExit("Unexpected duplicate bindings/wasm workspace entries")

if args.enable:
    if present:
        raise SystemExit("bindings/wasm is already a workspace member")
    content, matches = re.subn(r'(?m)^([ \t]*)"xtask",[ \t]*$', r'\1"xtask",\n' + entry.rstrip("\n"), content)
    if matches != 1:
        raise SystemExit(f"Expected exactly one workspace xtask member, found {matches}")
else:
    if present != 1:
        raise SystemExit("Expected exactly one generated bindings/wasm workspace entry to remove")
    content = content.replace(entry, "", 1)

path.write_text(content)

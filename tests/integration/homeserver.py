"""Disposable loopback-only Synapse. No production accounts or persistent data."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import yaml


def api(base, path, body=None):
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def main():
    ready = Path(sys.argv[1])
    child = None
    directory = tempfile.TemporaryDirectory(prefix="fern-matrix-fixture-")

    def stop(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        data = Path(directory.name)
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        shared_secret = secrets.token_hex(32)
        config = {
            "server_name": f"127.0.0.1:{port}", "public_baseurl": base,
            "pid_file": str(data / "synapse.pid"), "report_stats": False,
            "listeners": [{"port": port, "bind_addresses": ["127.0.0.1"], "type": "http", "tls": False,
                           "resources": [{"names": ["client"], "compress": False}]}],
            "database": {"name": "sqlite3", "args": {"database": str(data / "homeserver.db")}},
            "media_store_path": str(data / "media"), "signing_key_path": str(data / "signing.key"),
            "registration_shared_secret": shared_secret, "enable_registration": False,
            "macaroon_secret_key": secrets.token_hex(32), "form_secret": secrets.token_hex(32),
            "federation_domain_whitelist": [], "suppress_key_server_warning": True,
            "trusted_key_servers": [], "enable_metrics": False,
            "room_list_publication_rules": [{"action": "allow"}],
            "rc_message": {"per_second": 100, "burst_count": 1000},
            "rc_admin_redaction": {"per_second": 100, "burst_count": 1000},
            "rc_login": {key: {"per_second": 100, "burst_count": 1000}
                         for key in ["address", "account", "failed_attempts"]},
        }
        (data / "homeserver.yaml").write_text(yaml.safe_dump(config))
        # Logs stay inside the temporary directory and are never uploaded as CI artifacts.
        with (data / "process.log").open("w") as log:
            child = subprocess.Popen([sys.executable, "-m", "synapse.app.homeserver", "--config-path",
                                      str(data / "homeserver.yaml")], cwd=data, stdout=log, stderr=log)
            deadline = time.monotonic() + 90
            while True:
                if child.poll() is not None:
                    raise RuntimeError("Disposable Synapse exited before becoming ready")
                try:
                    versions = api(base, "/_matrix/client/versions")
                    break
                except (OSError, ValueError):
                    if time.monotonic() > deadline:
                        raise RuntimeError("Disposable Synapse did not become ready within 90 seconds")
                    time.sleep(0.25)
            if not versions.get("unstable_features", {}).get("org.matrix.simplified_msc3575"):
                raise RuntimeError("Pinned Synapse does not advertise native sliding sync")
            users = []
            for username in ["alice", "bob", "reference"]:
                password = secrets.token_urlsafe(32)
                nonce = api(base, "/_synapse/admin/v1/register")["nonce"]
                mac = hmac.new(shared_secret.encode(), digestmod=hashlib.sha1)
                mac.update(b"\0".join([nonce.encode(), username.encode(), password.encode(), b"notadmin"]))
                registered = api(base, "/_synapse/admin/v1/register", {
                    "nonce": nonce, "username": username, "password": password, "admin": False,
                    "mac": mac.hexdigest(),
                })
                users.append({"username": username, "password": password, "userId": registered["user_id"],
                              "token": registered["access_token"]})
            # Credentials only in a mode-0600 temporary file; never in stdout, args or CI logs.
            descriptor = os.open(ready, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as output:
                json.dump({"base": base, "version": "1.161.0", "users": users}, output)
            print("Disposable Synapse ready (native sliding sync)", flush=True)
            child.wait()
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        ready.unlink(missing_ok=True)
        directory.cleanup()


if __name__ == "__main__":
    main()

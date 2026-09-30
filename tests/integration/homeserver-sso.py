"""Disposable Synapse with OIDC-only login for SSO integration tests.

Backend of the legacy-SSO round trip: password login is disabled and a single
``oidc_providers`` entry points at the test IdP from ``OIDC_IDP``. Users are
pre-created through the admin API so the IdP subject maps onto existing
accounts (``allow_existing_users``).

Prints one line when ready:
    FERN_SSO_FIXTURE={"base": ..., "users": [...]}
"""

import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

IDP = os.environ["OIDC_IDP"]
USERS = [
    ("alice", "Alice Cooper"),
    ("bob", "Bob Marley"),
]


def announce(payload):
    print("FERN_SSO_FIXTURE=" + json.dumps(payload), flush=True)


def wait(base, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/_matrix/client/versions", timeout=5) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("SSO homeserver did not start")


def api(base, method, path, token=None, data=None):
    request = urllib.request.Request(base + path, method=method,
                                     data=json.dumps(data).encode() if data is not None else None,
                                     headers={"Content-Type": "application/json"})
    if token:
        request.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def free_port(start=18700, tries=10):
    import socket
    for port in range(start, start + tries):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("No free loopback port for the SSO fixture")


def main():
    workdir = tempfile.mkdtemp(prefix="fern-sso-synapse-")
    secret = "fern-sso-test-secret"
    port = free_port()
    config = {
        "server_name": "sso-test",
        "public_baseurl": "PLACEHOLDER",
        "pid_file": os.path.join(workdir, "homeserver.pid"),
        "listeners": [{"port": port, "bind_addresses": ["127.0.0.1"], "type": "http",
                       "tls": False, "x_forwarded": False,
                       "resources": [{"names": ["client", "federation"]}]}],
        "database": {"name": "sqlite3", "args": {"database": os.path.join(workdir, "homeserver.db")}},
        "log_config": os.path.join(workdir, "log.yaml"),
        "media_store_path": os.path.join(workdir, "media"),
        "registration_shared_secret": secret,
        "report_stats": False,
        "macaroon_secret_key": "sso-test-macaroon",
        "form_secret": "sso-test-form",
        "signing_key_path": os.path.join(workdir, "signing.key"),
        "trusted_key_servers": [],
        "password_config": {"enabled": False},
        "oidc_providers": [{
            "idp_id": "fern-test-idp",
            "idp_name": "Fern Test IdP",
            "issuer": IDP + "/",
            "client_id": "fern-test-client",
            "client_secret": "fern-test-secret",
            "scopes": ["openid"],
            "allow_existing_users": True,
            # The test IdP issues bare localparts as subjects; map them
            # directly so existing accounts link without the username picker.
            "user_mapping_provider": {"config": {"localpart_template": "{{ user.sub }}"}},
        }],
    }
    base = f"http://127.0.0.1:{port}"
    config["public_baseurl"] = base + "/"
    with open(os.path.join(workdir, "homeserver.yaml"), "w") as handle:
        json.dump(config, handle)
    with open(os.path.join(workdir, "log.yaml"), "w") as handle:
        handle.write("version: 1\n")
    os.makedirs(os.path.join(workdir, "media"), exist_ok=True)
    venv_python = os.environ.get("FERN_SYNAPSE_PYTHON", ".cache/fern-synapse/bin/python")
    generate = [venv_python, "-m", "synapse.app.homeserver",
                "--config-path", os.path.join(workdir, "homeserver.yaml"),
                "--generate-keys"]
    subprocess.run(generate, check=True, capture_output=True)
    proc = subprocess.Popen(
        [venv_python, "-m", "synapse.app.homeserver", "--config-path", os.path.join(workdir, "homeserver.yaml")],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait(base)
        users = []
        for username, displayname in USERS:
            # Passwords are inert (password login is disabled); they only
            # satisfy the shared-secret registration recipe.
            password = "oidc-only-" + username
            nonce = api(base, "GET", "/_synapse/admin/v1/register")["nonce"]
            mac = hmac.new(secret.encode(), digestmod=hashlib.sha1)
            mac.update(b"\0".join([nonce.encode(), username.encode(), password.encode(), b"notadmin"]))
            body = {"nonce": nonce, "username": username, "password": password,
                    "mac": mac.hexdigest(), "admin": False}
            created = api(base, "POST", "/_synapse/admin/v1/register", None, body)
            users.append({"username": username, "userId": created["user_id"], "token": created["access_token"]})
        announce({"base": base, "users": users})
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.terminate()


if __name__ == "__main__":
    main()

"""Disposable OIDC identity provider for SSO integration tests.

Speaks just enough OpenID Connect for Synapse ``oidc_providers``: discovery,
JWKS, an account chooser (the test clicks who to log in as), code exchange and
userinfo. Auto-approves the chosen account without passwords. Test-only: never
expose this outside loopback.

Prints one line when ready:
    OIDC_IDP=http://127.0.0.1:PORT
"""

import base64
import hashlib
import html
import json
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

CLIENT_ID = "fern-test-client"
CLIENT_SECRET = "fern-test-secret"
# Tests only ever run on loopback; the redirect target is validated per code.
USERS = {"alice": "Alice", "bob": "Bob"}

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUBLIC_NUMBERS = KEY.public_key().public_numbers()
KID = "fern-test-key"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_int(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return b64url(raw)


def sign_jwt(claims: dict) -> str:
    header = b64url(json.dumps({"alg": "RS256", "kid": KID, "typ": "JWT"}).encode())
    payload = b64url(json.dumps(claims).encode())
    signature = KEY.sign(f"{header}.{payload}".encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{payload}.{b64url(signature)}"


CODES: dict[str, dict] = {}
REQUESTS: dict[str, dict] = {}
TOKENS: dict[str, str] = {}


class Handler(BaseHTTPRequestHandler):
    server_version = "FernTestIdP/1"

    def log_message(self, *args):
        pass

    def base(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://127.0.0.1:{port}"

    def send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        issuer = self.base() + "/"
        if parsed.path == "/.well-known/openid-configuration":
            self.send_json({
                "issuer": issuer,
                "authorization_endpoint": self.base() + "/authorize",
                "token_endpoint": self.base() + "/token",
                "userinfo_endpoint": self.base() + "/userinfo",
                "jwks_uri": self.base() + "/jwks.json",
                "response_types_supported": ["code"],
                "subject_types_supported": ["public"],
                "id_token_signing_alg_values_supported": ["RS256"],
                "scopes_supported": ["openid"],
                "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
            })
        elif parsed.path == "/jwks.json":
            self.send_json({"keys": [{
                "kty": "RSA", "use": "sig", "kid": KID, "alg": "RS256",
                "n": b64url_int(PUBLIC_NUMBERS.n), "e": b64url_int(PUBLIC_NUMBERS.e),
            }]})
        elif parsed.path == "/userinfo":
            parts = (self.headers.get("Authorization") or "").split()
            sub = TOKENS.get(parts[1]) if len(parts) == 2 and parts[0] == "Bearer" else None
            if sub is None:
                self.send_json({"error": "invalid_token"}, 401)
            else:
                self.send_json({"sub": sub})
        elif parsed.path == "/authorize":
            client_id = query.get("client_id", [""])[0]
            redirect_uri = query.get("redirect_uri", [""])[0]
            if client_id != CLIENT_ID or not redirect_uri.startswith("http://127.0.0.1:"):
                self.send_json({"error": "unauthorized_client"}, 400)
                return
            req_id = secrets.token_urlsafe(16)
            REQUESTS[req_id] = {
                "redirect_uri": redirect_uri,
                "state": query.get("state", [""])[0],
                "nonce": query.get("nonce", [""])[0],
            }
            options = "".join(
                f'<li><form method="post" action="/choose">'
                f'<input type="hidden" name="req" value="{req_id}"/>'
                f'<input type="hidden" name="user" value="{user}"/>'
                f'<button type="submit">Log in as {html.escape(name)}</button></form></li>'
                for user, name in USERS.items()
            )
            page = f"<html><body><h1>Fern test provider</h1><ul>{options}</ul></body></html>".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        fields = urllib.parse.parse_qs(self.rfile.read(length).decode())
        get = lambda name: fields.get(name, [""])[0]
        if parsed.path == "/choose":
            pending = REQUESTS.pop(get("req"), None)
            user = get("user")
            if pending is None or user not in USERS:
                self.send_json({"error": "invalid_request"}, 400)
                return
            code = secrets.token_urlsafe(24)
            CODES[code] = {"sub": user, "nonce": pending["nonce"], "redirect_uri": pending["redirect_uri"]}
            location = pending["redirect_uri"] + ("&" if "?" in pending["redirect_uri"] else "?") + urllib.parse.urlencode(
                {"code": code, "state": pending["state"]})
            self.send_response(302)
            self.send_header("Location", location)
            self.end_headers()
        elif parsed.path == "/token":
            client_id, secret = get("client_id"), get("client_secret")
            basic = self.headers.get("Authorization", "")
            if basic.startswith("Basic "):
                decoded = base64.b64decode(basic[6:]).decode()
                client_id, _, secret = decoded.partition(":")
            code = CODES.pop(get("code"), None)
            valid = (
                code is not None and get("grant_type") == "authorization_code"
                and client_id == CLIENT_ID and secret == CLIENT_SECRET
                and get("redirect_uri") == code["redirect_uri"]
            )
            if not valid:
                self.send_json({"error": "invalid_grant"}, 400)
                return
            now = int(time.time())
            issuer = self.base() + "/"
            id_token = sign_jwt({
                "iss": issuer, "sub": code["sub"], "aud": CLIENT_ID,
                "iat": now, "exp": now + 300, "nonce": code["nonce"],
            })
            access_token = secrets.token_urlsafe(24)
            TOKENS[access_token] = code["sub"]
            self.send_json({
                "access_token": access_token, "token_type": "Bearer",
                "expires_in": 300, "id_token": id_token,
            })
        else:
            self.send_response(404)
            self.end_headers()


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"OIDC_IDP=http://127.0.0.1:{port}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

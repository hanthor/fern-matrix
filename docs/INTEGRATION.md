# Live Matrix integration

The live suite starts an actual **Synapse 1.161.0**, verifies native sliding-sync discovery, registers three disposable users, and exercises Fern's actual Rust WASM in isolated Chromium contexts. The third user operates through the Matrix HTTP client API as a reference for server state. It is not an independent E2EE implementation; encrypted interoperability with Element X remains #6.

## Run locally

Requires Python 3.12, Node 24 and Playwright's Chromium. The fixture uses SQLite and binds only to a randomly selected loopback port. Docker and real-account credentials are not required.

```sh
npm ci
python3.12 -m venv .cache/fern-synapse
.cache/fern-synapse/bin/pip install -r tests/integration/requirements.txt
npx playwright install chromium
npm run test:integration
```

Alternatively, use `uv venv .cache/fern-synapse --python 3.12` and `uv pip sync --python .cache/fern-synapse/bin/python tests/integration/requirements.txt`. `FERN_SYNAPSE_PYTHON` selects an existing isolated Synapse environment. `FERN_CHROMIUM_PATH` optionally selects a browser executable; the default uses Playwright's installed browser on every machine.

The runner creates a temporary fixture directory and terminates Synapse after success, failure or interruption. Its temporary database, media, signing key and accounts are removed. Passwords and admin registration secrets are random per run; credentials are written to a mode-0600 temporary file, never stdout or command-line arguments. Registration is disabled except through the internal shared-secret fixture setup, federation is disallowed, and usage statistics are off.

Do not serve this fixture on a public interface or reuse it for personal accounts. Browser test contexts are discarded after each test. Logout's persistent-database cleanup limitation remains tracked in #7; context teardown isolates this suite without pretending the app has fixed that behavior.

## Coverage and evidence boundaries

- Password login, two accounts in one engine, separate databases, restored sessions and logout isolation.
- Two isolated browser clients accepting invites and exchanging text, replies, edits, reactions, redactions and polls.
- Two encrypted Fern clients exchanging text, replies, edits, reactions and file media. The test checks the sender's raw `/messages` response to confirm the homeserver stores ciphertext without the message body or attachment name/bytes.
- A separately implemented `matrix-nio` 0.26.0 client logs in with E2EE enabled and joins a Fern-created encrypted room. Both clients exchange encrypted text and files; they also exchange a reply, an edit and reactions. Fern and matrix-nio independently download/decrypt the other's encrypted attachment, and server events are checked for ciphertext rather than plaintext.
- Recovery backup creation, rejection of a second backup setup, unavailable-backup and invalid-key failures, a visible missing-key decryption error on a fresh device, and encrypted-history/media decryption after recovery.
- Incoming same-account device-verification requests, SAS comparison and mutual approval, user cancellation, and SAS rejection on a separate live flow.
- Typing notifications, server-side receipt state and history pagination from a fresh SDK store, including an actual server history request.
- Public-directory search, encrypted DM creation and member lookup.

The suite deliberately separates protocol tests from the demo UI tests. Matrix-nio verifies encrypted text, replies, edits, reactions and file exchange independently; backup/recovery and device verification currently use Fern's Rust SDK on both ends. Verification protocol timeout and independent-client backup/verification flows remain untested. A passing adapter test proves that adapter scenario against the pinned fixture, not federation, production server compatibility, Element X interoperability, or call correctness. Update `docs/FEATURES.md` only for scenarios actually exercised successfully.

CI runs both suites and the build in `.github/workflows/integration.yml`. Failure output identifies the scenario and assertion; no screenshots, traces, HAR files, raw server logs or credential files are uploaded. Keep test message content synthetic. For a failure requiring server diagnostics, inspect the ephemeral logs locally while the process is alive and redact before sharing.

## External homeservers and independent clients

This automated runner always starts its own disposable fixture. Do not point it at production accounts: tests create rooms, send messages and sign out sessions. External-server qualification is a separate manual run with dedicated consenting test users and documented cleanup:

1. Record homeserver version/configuration, native sliding-sync discovery and authentication capabilities.
2. Sign in two dedicated Fern test accounts; repeat the suite's room and messaging scenarios through the UI.
3. Use a current independent Element X client for encrypted text, media, edits, reactions, verification, recovery and new-device restore (#6); the automated matrix-nio peer is not a substitute for Element X qualification.
4. Exercise lost network, server restarts, token expiry and account removal (#7, #8). Preserve recovery keys before intentionally deleting local crypto state.
5. Record browser/OS/client versions and pass/fail evidence without credentials, recovery keys or personal message content.

## MatrixRTC fixture boundary

Synapse alone is not a working calling stack. #25 must add or connect a separate disposable stack with compatible MatrixRTC authorization, LiveKit, HTTPS and an Element Call host; follow the [official Element Call self-hosting guide](https://github.com/element-hq/element-call/blob/main/docs/self_hosting.md) and pin its versions. The local core fixture does not advertise fake RTC support.

Use two dedicated call participants plus a group-call participant. Validate authenticated service discovery, permissions, media exchange, join/leave/reconnect and room/account switching. Configure `VITE_ELEMENT_CALL_URL` and its allowed frame origin. Record incoming-call/background limitations separately (#26, #24); the call widget loading successfully is not evidence of media delivery.

## Fixture upgrades

Change `requirements.in`, regenerate the fully pinned `requirements.txt` for Python 3.12, and verify native sliding sync and all scenarios before updating the recorded fixture version. Synapse is a development/test dependency; Fern remains a static browser application talking directly to the user's homeserver.

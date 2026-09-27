# Fern

A calm, responsive, multi-account Matrix client built with Vue 3, Frappe UI, and the Matrix Rust SDK compiled to WebAssembly. Its account rail and space navigation take inspiration from Cinny. The browser SDK integration follows Element HQ's Aurora experiment.

**[Open Fern](https://hanthor.github.io/fern-matrix/) · [Source](https://github.com/hanthor/fern-matrix) · [Roadmap](https://github.com/hanthor/fern-matrix/issues/2)**

![Fern desktop interface](docs/screenshots/desktop.png)

Fern is an early implementation, **not a finished Element X replacement**. The interactive local demo works without credentials. Live messaging uses the Rust SDK; there is no Matrix JavaScript SDK fallback. Real-account interoperability and the calling/verification flows still require testing against a homeserver and other clients.

## Run

Requires Node 24 (or Node >=20.19).

```sh
npm ci
npm run dev
```

Open http://localhost:5173. The default view is explicitly labeled **Local demo**. Add your account from the account rail or “Connect your account”. The homeserver must support password authentication and native sliding sync. Multiple accounts sync independently and use separate IndexedDB stores.

```sh
npm test
npm run test:e2e
npm run build
npm run preview
```

Browser tests use `FERN_CHROMIUM_PATH` when supplied, otherwise the locally installed Chromium path. For a new machine, run `npx playwright install chromium`, then set `FERN_CHROMIUM_PATH` to its executable. `docs/DEVELOPMENT.md` describes the tests and architecture.

## Implemented

| Area | Behavior |
| --- | --- |
| Responsive UI | Desktop account rail, room sidebar, timeline and details; phone room list / conversation / details views |
| Accounts | Password login, saved sessions, restoration, switching, logout, token refresh delegate, separate encrypted IndexedDB stores |
| Conversations | Native sliding sync, SDK room-list observation, room hierarchy, unread badges, favorites, invitations, room creation, DMs, joining and leaving |
| Messaging | SDK timeline diffs, text, local echoes, history pagination, drafts, replies, edits, redaction, reactions, typing and read receipts |
| Media | Encrypted file upload and SDK media download/decryption; image previews for loaded files |
| Polls | Creation, single-choice voting and results |
| Discovery | Public homeserver room search and pagination; room / person quick switch; loaded-message search |
| Room details | Topic, room ID, members, shared files and invitations |
| Security | Device information, fingerprints, existing-key recovery, new recovery setup when no backup exists, emoji / number device verification |
| Calling | Element Call iframe connected to the Rust SDK widget driver, constrained capabilities and checked postMessage origin/source; requires MatrixRTC infrastructure |
| Preferences | Light / dark / system appearance, compact messages, display name editing |
| Notifications | Browser notifications for the selected room while the app is open |
| Installation | Web app manifest, app icons, versioned offline shell; SDK WASM cached after first use |
| Hosting | GitHub Pages workflow and nginx container configuration |

## Element X parity still to implement

OIDC / SSO and QR login; full incoming-call / ringing lifecycle; voice recording and location sharing; rich text / mention autocomplete; threads; authenticated avatars; full event / media galleries and pinned-message browsing; server-wide message search; per-room notification preferences and background push; moderation / power-level UI; space creation and editing; accessibility and localization audits; native iOS / Android / desktop packaging; recovery setup edge cases; comprehensive encrypted interoperability and upgrade testing. See [the feature checklist](docs/FEATURES.md), [versioned parity inventory](docs/PARITY.md), and [milestone roadmap](https://github.com/hanthor/fern-matrix/issues/2).

Do not use the demo as evidence of live federation, encryption interoperability, or call media delivery. The browser suite verifies local UI behavior and that the vendored Rust WASM initializes and exposes its builder APIs.

## Hosting and Pages

`main` deploys with `.github/workflows/pages.yml`. Pages builds set the Vite base path from GitHub's Pages metadata. Hash routing avoids server rewrite requirements. The build rewrites the manifest and service worker for the same base path.

```sh
FERN_BASE_PATH=/fern-matrix/ npm run build
FERN_BASE_PATH=/fern-matrix/ npm run preview
```

For another repository name, the Actions workflow derives the path automatically. Serve `dist/` over HTTPS. `application/wasm` MIME type is required. The WASM asset is about 51 MB uncompressed and loaded only when a real account needs it; compression is strongly recommended. The entire source tree fits GitHub's normal file limit without LFS.

For a dedicated origin:

```sh
docker build -t fern-matrix .
docker run --rm -p 8080:80 fern-matrix
```

Set `VITE_ELEMENT_CALL_URL` at build time for a self-hosted calling service and update nginx's `frame-src` policy accordingly. The default calling service is `https://call.element.io`. See [Element Call's hosting requirements](https://github.com/element-hq/element-call/blob/main/docs/self_hosting.md).

## Local data

Messages and crypto keys are stored by the SDK in account-specific IndexedDB databases. Browser session credentials and the IndexedDB passphrase are stored in origin-local storage to support restoration. The passphrase is **not** protection against other scripts running on that origin. Use a dedicated trusted origin for sensitive accounts; GitHub project Pages share an origin with your other project sites. Drafts are local. The service worker caches only public app assets, never Matrix API responses or tokens. Logging out removes the session and stops its listeners; encrypted SDK database cleanup is not yet implemented. Keep a recovery key before clearing browser data.

## SDK provenance and license

The generated TypeScript bindings and WASM are vendored from [element-hq/aurora](https://github.com/element-hq/aurora) with their license preserved. See [SDK provenance](docs/SDK-PROVENANCE.md) for commits, SHA256, regeneration and the syntax compatibility patch. This project is distributed under **AGPL-3.0-only**; [LICENSE.txt](LICENSE.txt) contains the license. Upstream-generated files retain their notices.

Sources of design and architecture inspiration: [Frappe UI](https://github.com/frappe/frappe-ui), [Cinny](https://github.com/cinnyapp/cinny), [Aurora](https://github.com/element-hq/aurora), and [Matrix Rust SDK](https://github.com/matrix-org/matrix-rust-sdk). No Cinny application source was copied.

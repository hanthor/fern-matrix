# Architecture

`src/sdk/engine.ts` is the only app-specific adapter to the vendored Rust SDK. The SDK initializes lazily when real accounts are restored or added. Its Rust-backed clients, task handles, timelines, event identifiers and media sources are kept outside Vue reactivity. `src/store.ts` owns normalized render data and the explicitly separate demo mode.

Each login gets a UUID store and a random IndexedDB passphrase. Sessions are keyed by store UUID rather than user ID, so two sessions for the same Matrix user remain distinct. Each account has its own sync service and observer handles. Room selection uses a generation counter to ignore delayed results from a previously selected account or room. The draft key includes both account and room IDs.

Room list observation triggers summary refreshes. Refreshes use batches of 20 SDK reads and are coalesced per account. A four-second refresh also keeps summaries current when SDK callbacks are sparse. Active rooms are subscribed through the room list service. Timelines apply the SDK's vector updates, keeping local and remote event identifiers for edits, redactions and reactions. Media downloads use SDK decryption and safe blob MIME types. Object URLs for live media are revoked on logout and disposal.

The call iframe is connected to `makeWidgetDriver`; inbound messages require an exact origin, iframe window, and widget ID match. SDK Element Call permissions constrain access to the room and current user/device. The iframe does not receive the account access token in its URL. The bridge is canceled and listeners removed when the call view closes.

The demo is persisted separately. User-uploaded demo blobs are not persisted across reloads because their object URLs would expire. Recovery keys and passwords are not written to the draft store.

## Validation

- `npm test`: batched SDK timeline updates, local-echo replacement, history ordering and vector reset/removal behavior.
- `npm run test:e2e`: desktop messaging, replies, edits, reaction toggling, poll voting and reload persistence; account and draft isolation; creation and quick switching; security view; phone navigation and width; actual Rust WASM initialization and client creation with encrypted IndexedDB against a mocked versions endpoint.
- `npm run build`: TypeScript / Vue checking, static build, versioned offline shell and base-aware manifest generation.
- Production smoke check: Pages subdirectory asset resolution, SDK WASM initialization, shell offline reload and dark / mobile rendering.

For portable browser tests, supply `FERN_CHROMIUM_PATH=/path/to/chromium`. The default points to the shared development environment's browser installation; it is intentionally not used by the Pages workflow.

Live Matrix tests require dedicated test accounts. Verify password login and reload restoration, independent sync with two accounts, encrypted messages / replies / edits / reactions and attachments between clients, history recovery, emoji verification, invites / DMs / directory membership, interrupted network recovery, logout, and a call with a second participant. These were not verified during the initial build. Calls require a homeserver advertising MatrixRTC and functioning MatrixRTC authorization / LiveKit services.

## Deployment

The build supports `FERN_BASE_PATH` (must start and end with `/`), default `/`. Vite rewrites app assets, demo attachments use `import.meta.env.BASE_URL`, and `scripts/build-sw.mjs` rewrites the manifest and service worker to that path. Routing uses URL hashes.

The service worker precaches only the shell and public JS / CSS / fonts / icons. The large Rust WASM is cached when first requested. No Matrix API response, session credential or remote media response enters the app-shell cache. Shell upgrades wait for existing windows to close, avoiding mixed old JS and new WASM artifacts.

# Feature coverage

Status distinguishes UI automation from untested live-account interoperability. See the [versioned Element X parity inventory](PARITY.md) for the full planning baseline and linked [roadmap issues](https://github.com/hanthor/fern-matrix/issues/2).

| Feature | Implemented | Initial validation |
| --- | --- | --- |
| Desktop / phone layout | Yes | Chromium desktop and 390px phone browser tests |
| Account switching and draft isolation | Yes | Demo UI/drafts plus live two-account SDK store/session isolation |
| SDK WASM initialization | Yes | Real Chromium WASM initialization / encrypted IndexedDB client creation against a mocked server |
| Password login / session restore / refresh | Yes | Login/restoration/logout verified against Synapse 1.161.0; token refresh still unverified |
| Native sliding sync / room lists / hierarchy | Yes | Sliding sync and invited/joined room lists verified live; space hierarchy unverified |
| E2EE message send / receive / recovery | Yes | Live Fern-to-Fern encryption, Rust SDK ↔ matrix-nio encrypted text and file exchange, server ciphertext inspection, and fresh-device backup restore; independent-client recovery interoperability pending |
| Text, reply, edit, reaction and redaction | Yes | Live plain/encrypted Fern device checks and encrypted matrix-nio text, reply, edit and reaction exchange; independent-client redaction remains untested |
| Attachment upload / decryption / downloads | Yes | Live encrypted file exchange between Fern Rust SDK devices and matrix-nio 0.26.0 in both directions; other-client qualification pending |
| Poll creation and voting | Yes | Live two-client poll/vote/result/selected-answer regressions plus demo UI |
| History pagination / read receipts / typing | Yes | Live two-client typing, server receipt state and fresh-client pagination through 65-event history |
| Device emoji / number verification | Yes | Live incoming request, matching SAS and mutual approval, cancellation and SAS rejection across two Fern devices; protocol timeout and independent-client verification pending |
| New backup setup / existing recovery key | Yes | Live backup setup, replacement guard, unavailable-backup and invalid-key failures, missing-key decryption error, and encrypted-history restore on a fresh device; independent-client recovery check pending |
| Public room discovery / room actions | Yes | Live directory, invite/join, encrypted DM creation and member lookup; other actions unverified |
| Element Call widget bridge | Yes | Type checked; needs MatrixRTC server and another participant |
| Offline app shell / subpath deployment | Yes | Production browser checks |
| Browser notifications | Selected room only | Requires browser permission; not background push |
| OIDC, SSO, QR login | No | Needed for modern authentication-only servers |
| Incoming calls / ringing | No | Current calling UI initiates or joins a room call |
| Threads / voice recording / location sharing | No | SDK bindings expose APIs; no UI yet |
| Rich text / mention input / authenticated avatars | No | Plain text safely rendered without raw HTML |
| Pinned-message browsing / full media gallery | No | SDK pin operation exists; shared-file list covers loaded messages |
| Search across account history | No | Current search is rooms and loaded room messages |
| Per-room notification rules / push | No | SDK settings APIs not yet exposed |
| Moderation / power levels / room settings editing | No | SDK APIs not yet exposed |
| Space creation and editing | No | Existing spaces and hierarchy supported |
| Native packages | No | Mobile and desktop browser / installable web app only |
| Localization / full accessibility audit | No | Basic labels, keyboard navigation, reduced-motion handling |

Complete Element X parity remains a product roadmap, not a claim about this version.

Live adapter evidence: [integration suite](INTEGRATION.md), Synapse 1.161.0, matrix-nio 0.26.0, Chrome for Testing 153.0.8010.12 on Linux, 2026-09-27. Independent interoperability covers encrypted text, replies, edits, reactions and files; verification and recovery have only been exercised between Fern devices. This is not Element X qualification.

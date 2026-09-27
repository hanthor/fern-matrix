# Feature coverage

Status distinguishes UI automation from untested live-account interoperability. See the [versioned Element X parity inventory](PARITY.md) for the full planning baseline and linked [roadmap issues](https://github.com/hanthor/fern-matrix/issues/2).

| Feature | Implemented | Initial validation |
| --- | --- | --- |
| Desktop / phone layout | Yes | Chromium desktop and 390px phone browser tests |
| Account switching and draft isolation | Yes | Demo UI/drafts plus live two-account SDK store/session isolation |
| SDK WASM initialization | Yes | Real Chromium WASM initialization / encrypted IndexedDB client creation against a mocked server |
| Password login / session restore / refresh | Yes | Login/restoration/logout verified against Synapse 1.161.0; token refresh still unverified |
| Native sliding sync / room lists / hierarchy | Yes | Sliding sync and invited/joined room lists verified live; space hierarchy unverified |
| E2EE message send / receive / recovery | Yes | Rust SDK implementation; needs two-client interoperability |
| Text, reply, edit, reaction and redaction | Yes | Two isolated Rust SDK clients against live Synapse, unencrypted room; encrypted interoperability pending |
| Attachment upload / decryption / downloads | Yes | Type checked; needs encrypted media integration |
| Poll creation and voting | Yes | Live two-client poll/vote/result/selected-answer regressions plus demo UI |
| History pagination / read receipts / typing | Yes | Live two-client typing, server receipt state and fresh-client pagination through 65-event history |
| Device emoji / number verification | Yes | Type checked; needs a second verified client |
| New backup setup / existing recovery key | Yes | Type checked; needs account / backup integration |
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

Live adapter evidence: [integration suite](INTEGRATION.md), Synapse 1.161.0, Chrome for Testing 153.0.8010.12 on Linux, 2026-09-27. The reference HTTP client validates server state; it does not establish independent encryption interoperability.

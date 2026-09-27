# Feature coverage

Status distinguishes UI automation from untested live-account interoperability.

| Feature | Implemented | Initial validation |
| --- | --- | --- |
| Desktop / phone layout | Yes | Chromium desktop and 390px phone browser tests |
| Account switching and draft isolation | Yes | Browser tests with two demo accounts |
| SDK WASM initialization | Yes | Real Chromium WASM module / builder test |
| Password login / session restore / refresh | Yes | Type checked; needs a live test account |
| Native sliding sync / room lists / hierarchy | Yes | Type checked; needs homeserver integration |
| E2EE message send / receive / recovery | Yes | Rust SDK implementation; needs two-client interoperability |
| Text, reply, edit, reaction and redaction | Yes | Demo sending, reply, edit and reaction tests; redaction UI implemented |
| Attachment upload / decryption / downloads | Yes | Type checked; needs encrypted media integration |
| Poll creation and voting | Yes | Demo browser tests |
| History pagination / read receipts / typing | Yes | Type checked; needs live integration |
| Device emoji / number verification | Yes | Type checked; needs a second verified client |
| New backup setup / existing recovery key | Yes | Type checked; needs account / backup integration |
| Public room discovery / room actions | Yes | Type checked and local room creation tested |
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

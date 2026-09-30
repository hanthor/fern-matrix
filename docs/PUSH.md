# Background push evaluation (#24)

Status: evaluated — **not implemented**. Fern ships no push gateway, so
closed-tab and offline notifications are unsupported. The settings tab says
so, and the browser suite asserts the disclosure.

## What Matrix push needs

- A **push gateway** reachable by the user's homeserver (e.g. Sygnal for
  APNs/FCM, or a WebPush gateway). The client registers a *pusher* with the
  homeserver (`POST /pushers/set`) containing the gateway URL and the
  device's push key; the homeserver then POSTs notification events to the
  gateway, which fans out to Apple/Google push networks.
- **WebPush credentials**: a VAPID keypair operated alongside the gateway,
  plus a registered service worker that decrypts and displays pushes.
- **Apple/Google developer presence** for native transports (APNs/FCM
  sender configuration on the gateway).

## Why Fern does not provision one

- GitHub Pages hosts static assets only: there is nowhere to run the
  gateway, hold the VAPID private key, or manage APNs/FCM credentials.
- **Privacy**: a gateway observes push metadata for every notification —
  sender, room, device, unread counts and timing. Bodies stay encrypted
  when the room is encrypted, but metadata alone identifies who talks to
  whom and when. Running a first-party gateway means accepting that
  responsibility; pointing users at a third-party gateway exports their
  metadata to that operator.
- **Operating cost drivers**: always-on hosting for the gateway, Apple
  Developer and FCM sender administration, certificate/key rotation,
  abuse and reliability monitoring. No per-message price is quoted here
  because there is no selected provider.

## Requirements when this is revisited

- Provision and document a first-party gateway before registering any
  pusher; never default users onto a third-party gateway silently.
- Register one pusher per account/device with distinct app/display names
  so multi-account notifications stay attributable.
- Delete every pusher on sign-out, account removal and deactivation
  (#7 covers session teardown); a stale pusher keeps waking a device the
  user has left.
- Push payloads must carry identifiers only — never message plaintext or
  credentials. The client fetches content after the user taps.
- Re-test closed-tab, offline, permission-revocation, logout and
  multi-account deduplication on the supported browser matrix before
  claiming support.

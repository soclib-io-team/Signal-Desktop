# Chunk 2 OAuth connection and account settings

Implements the Desktop side of the
[Chunk 1 contract](chunk-1-vanguard-contract.md). Deployment instructions are in
[OAuth setup](../operations/oauth-setup.md). The Rails context endpoint and live
client registration must be deployed separately; no roster or mapping operations
are implemented here.

## Connection design

- `oauth4webapi` handles discovery, authorization-response validation, PKCE, token
  responses, refresh, and revocation. The system browser authenticates the user;
  no confidential client secret or embedded login browser is used.
- Deployment configuration pins one HTTPS origin and client ID. Discovery issuer
  validation and same-origin endpoint checks precede login. Requests reject
  redirects and time out after 15 seconds. API paths are fixed in main-process
  code; renderer callers cannot supply URLs, headers, or credentials.
- A fixed, configurable loopback port supports exact Doorkeeper callback
  registration. The listener checks host, path, method, and a unique random state;
  the OAuth library checks the authorization response before exchanging its code.
  Each login uses a fresh S256 verifier and times out after five minutes. The
  listener closes on completion, failure, cancellation, or account change.
- Encrypted sessions are bound to provider origin, client ID, and local Signal
  account. No plaintext or memory-only storage fallback is provided. Failed
  decryption requires disconnect/reconnect. Refresh runs on demand while checking
  connection context, with a 60-second expiry margin; concurrent checks share the
  current operation and rotating refresh tokens are saved before further use.
- The authenticated context endpoint supplies Vanguard identity and organization
  access. Effective UI permissions intersect server capabilities with granted
  OAuth scopes. Context validation failure, outages, and missing permissions
  never appear as a successful empty roster. The UI receives no OAuth tokens;
  raw provider errors are not logged or returned through IPC.
- Disconnect clears local credentials first and attempts remote revocation.
  Account changes and data erasure cancel pending work and clear local credentials;
  they do not depend on provider availability. Generation checks prevent late
  refresh/login responses from restoring a disconnected session. No roster cache
  exists in this chunk.
- Settings provides connect, reconnect, refresh, cancel, identity/permissions,
  roster-scope inspection, and disconnect controls. Disclosure explains future
  ACI mapping writes. This custom-build panel currently uses English text.

## Upstream hooks

| File                                     | Reason for the small integration edit                                      |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `app/main.main.ts`                       | Install the main-process IPC handlers after app readiness.                 |
| `app/sql_channel.main.ts`                | Cancel pending authentication before erasing local configuration.          |
| `ts/textsecure/Storage.preload.ts`       | Notify Vanguard before a Signal account identifier is replaced or removed. |
| `ts/state/smart/Preferences.preload.tsx` | Bind the current Signal account to the narrow connection interface.        |
| `ts/components/Preferences.dom.tsx`      | Mount the isolated account-settings component.                             |
| `package.json`, `pnpm-lock.yaml`         | Pin the OAuth protocol library.                                            |
| `.oxlint/rules/enforceFileSuffix.mjs`    | Register that library's platform classification for dependency linting.    |

Implementation and tests otherwise remain in dedicated `vanguard` directories.
The connection IPC accepts only named actions and a validated Signal account ID,
and accepts messages only from the main window's top frame. The account-change
notification carries no account data and can only clear the connection.

## Validation

The 30 automated cases cover PKCE exchange, callback rejection, browser denial and
failure, cancellation, restart, refresh rotation, missing refresh tokens, expired
or revoked access, provider errors, malformed context, account/client/issuer
isolation, late responses after disconnect/erasure, secure-storage refusal,
settings rendering, and IPC input validation/error redaction.

Run the focused suite with:

```sh
node --import tsx node_modules/mocha/bin/mocha.js 'ts/test-node/vanguard/*_test.*' --timeout 10000
```

Callback tests require permission to bind temporary localhost ports. Full
TypeScript checking, linting of changed files, the dependency-boundary linter,
and the Rolldown application build also pass. Tests use a mocked provider and
real loopback callbacks; the deployment smoke test remains necessary to verify
actual Doorkeeper configuration, browser behavior, and the OS credential store.

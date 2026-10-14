# Chunk 2 OAuth connection and account settings

Implements the Desktop side of the
[Chunk 1 contract](chunk-1-vanguard-contract.md). Deployment instructions are in
[OAuth setup](../operations/oauth-setup.md). The original provider requirements (OAuth configuration, discovery, context, and
scope registration) are implemented or in progress in unreleased code. There are no older clients to
support. This revision preserves connect/reconnect and
describes the additional provider and Desktop work. Member fetching and mapping
UI follow in chunks 3–5; connection alone never loads a Member roster.

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
- The authenticated context endpoint supplies Vanguard identity and capabilities
  only; it never enumerates or returns roster descriptors or Members. Effective UI permissions intersect server capabilities with granted
  OAuth scopes. Context validation failure, outages, and missing permissions
  never appear as a successful empty roster. The UI receives no OAuth tokens;
  raw provider errors are not logged or returned through IPC.
- Disconnect clears local credentials first and attempts remote revocation.
  Account changes and data erasure cancel pending work and clear local credentials;
  they do not depend on provider availability. Generation checks prevent late
  refresh/login responses from restoring a disconnected session. With group
  settings added, disconnect must also durably clear every group connection flag
  for this account/issuer/user and discard in-memory Members. Local cleanup cannot
  depend on provider availability; report and retry failed local persistence rather
  than claiming it succeeded. No Member cache exists in this chunk.
- Settings provides connect, reconnect, refresh, cancel, identity/permissions,
  and disconnect controls. Remove roster-scope inspection from the Desktop flow.
  Connecting confirms success and stops; refresh here refreshes connection context,
  not Members. Disclosure explains future ACI mapping writes.
- A transient outage/token expiry requiring same-account reconnect preserves group
  flags but disables unavailable operations. Explicit OAuth termination, account
  switching, or data erasure clears them. A reconnect to a different Vanguard user
  must not inherit the previous user's groups or data.

## Settings and group integration to add

After OAuth is established, Settings > Vanguard also displays **Groups connected
to Vanguard**. It starts empty and lists only groups explicitly selected through
the Signal Group view's `...` menu. Each row has the Signal group name, current
member count, and **Disconnect** button; clicking the row opens its drill-down.
Counts/names come from Signal, without Vanguard Member requests.

The group menu offers **Connect to Vanguard** or **Disconnect from Vanguard**
according to the persisted flag, only while OAuth is connected. Persist using
Signal's local conversation/group-settings datastore, scoped to Signal account,
provider, and Vanguard user; do not add a server/protocol synchronization promise.
Group disconnect clears that flag, closes/cancels its active drill-down, and leaves
Vanguard mappings intact. OAuth disconnect clears all such flags for the connection.

Opening/reopening a connected group's drill-down always validates the flat Member
list with Vanguard. Retain a complete roster and its ETag in memory across groups:
first entry fetches all pages; later entries send `If-None-Match` to the initial
Members URL. A 304 reuses the complete roster; a 200 downloads a replacement into a
separate buffer and swaps it in only after all pages complete. Disable linking and
Proposed Matches while validation/replacement is pending or failed. Ignore late
responses after obsolete navigation/disconnect; do not persist Member data to disk. Chunk 3 specifies member icons and names;
chunk 4 adds Link/Unlink and its Member detail modal; chunk 5 adds Proposed Matches
above the list with checkboxes and **Link Signal users to members**. No Member
fetch is triggered by OAuth connect/reconnect, group connect, or the group list.
Live mapping checks after writes are permitted within the active drill-down.

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

For chunks 3–5, add only minimal upstream hooks for the group `...` menu,
conversation/group-settings persistence (including schema migration if required),
and Settings drill-down navigation. Keep implementations in Vanguard directories;
identify exact hook files in those chunks after inspecting Signal's current APIs.

Implementation and tests otherwise remain in dedicated `vanguard` directories.
The connection IPC accepts only named actions and a validated Signal account ID,
and accepts messages only from the main window's top frame. The account-change
notification carries no account data and can only clear the connection.

## Validation

The original implementation recorded 30 automated cases covering PKCE exchange, callback rejection, browser denial and
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
and the Rolldown application build were reported passing for that implementation.
Those results do not validate the revisions planned here. Tests use a mocked provider and
real loopback callbacks; the deployment smoke test remains necessary to verify
actual Doorkeeper configuration, browser behavior, and the OS credential store.

## Provider requirements

This section is a **change list against the already implemented provider**, not a
request to reimplement the original OAuth/context prerequisites. See the
[registration walkthrough](../operations/oauth-setup.md) for deployment setup.

### Preserve implemented OAuth and scope configuration

Keep Authorization Code + S256 PKCE, public-client registration, refresh/rotation,
finite access-token lifetimes, discovery, same-origin HTTPS endpoints, the exact
loopback redirect, revocation, consent, and login/2FA unchanged. Keep the existing
`api:read`, `members:read`, `api:write`, `signal_mappings:read`, and
`signal_mappings:write` registrations/allowlists. Desktop still uses discovery for
OAuth metadata, not ID tokens. No new scope or OAuth flow is needed for this revision.

### Make context identity-and-capabilities only

Revise the unreleased provider's `GET /api/v1/signal/context` to return caller IDs
and capabilities only. Remove roster descriptor construction and the `rosters`
response field. Do not implement or support `include_rosters` in any form. There
is one context response shape and no older-client compatibility branch. Rosters
are obtained only from the flat or per-chapter member-list endpoint below.

```http
GET /api/v1/signal/context
```

```json
{
  "user_id": "usr_example",
  "member_id": "mbr_example",
  "capabilities": {
    "read_members": true,
    "read_signal_mappings": true,
    "write_signal_mappings": false
  }
}
```

`member_id` may be null. Compute capabilities from current explicit permissions,
with flat-list read eligibility based on `member:show` over ChapterOrgs, without
querying a roster of Members. Mapping capabilities reflect `signal_mapping:read`
and `signal_mapping:write`. Effective Desktop permissions also intersect granted
OAuth scopes; reauthorize every actual resource operation. An authenticated user
with no eligible chapters may connect with false capabilities.

Update the Desktop validator and tests to this response shape and remove roster
inspection from connection settings. Remove descriptor types, enumeration limits,
and roster-related error paths from context; they are not part of this endpoint.

### Add the default flat Members endpoint; retain the chapter endpoint

API clients choose by URL, without changing the existing endpoint's purpose:

| Endpoint                                           | Intended use                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/signal/members`                       | New flat list across all ChapterOrgs authorized by `member:show`; the default and only Member-list endpoint used by the revised Desktop. |
| `GET /api/v1/chapter_orgs/:chapter_org_id/members` | Preserve the implemented per-ChapterOrg roster for clients that explicitly request a chapter.                                            |

Retain and revise the per-chapter implementation as a supported API option.
Preserve its envelope, existing fields, OAuth requirements, and established access
policy. Share underlying queries/serialization where useful. Desktop must not
loop over chapters or inspect their rosters at connection or at any later point.

The flat endpoint uses current organization-scoped `member:show`, including grants
covering a chapter through an ancestor. Do not require `member:index` or infer
access from admin status. Unit/District grants alone do not expose entire parent
chapters. It requires delegated `api:read` + `members:read`; its inline mappings
also require `signal_mappings:read` and explicit `signal_mapping:read` permission.
Insufficient mapping access must be explicit, not represented as unmapped Members.

Return the explicit Member projection, `full_name`, nullable `signal_user_id`
(Signal ACI), `chapter_org_name`, and `user_roles` per chunk 1.
For each CombinedUserRole include `role_slug`, title-cased `role_name`, associated
ChapterOrg name, and the unmodified `organization_type` as `chapter_org_type`.
Include only ChapterOrg-associated roles and no-org national roles; exclude Unit,
District, and other non-ChapterOrg roles. National chapter fields are null; no
login/roles yields `[]`. Respect role-field visibility and mark withheld expansions.

Use complete paginated reads with short-lived, consistent provider snapshots and
current authorization on every page as specified in chunk 1. Each drill-down
revalidates the whole roster; only initial or changed downloads need a new snapshot. Include
mapping values inline so the default view needs no separate dictionary
request. Keep the optional mapping dictionary contract as a separate API option.

For expected lists of 4,000–8,000 Members, start with a 1,000-record default and
maximum page size on the new endpoint. Desktop automatically fetches all pages,
shows loaded/total progress, and enables linking/Proposed Matches only after full
completion or a 304 validating the already complete retained roster. Return exact snapshot totals and retryable cursors; transient page
retries reuse the valid snapshot, while expiry/invalidation restarts the full read.
Keep the existing per-chapter response behavior unchanged. Measure representative
payloads and load times before finalizing page size/TTL. The Link dropdown searches
all loaded Members locally and virtualizes options rather than rendering 8,000
rows at once.

### Include former members in all Member-list endpoints

**Required change to both the new flat endpoint and the retained per-ChapterOrg
endpoint:** include former members by default, as well as candidates, full members,
and members on leave. This supersedes the old active-only behavior and the earlier
plan to defer former-member access. Preserve `status` so Desktop can show the red
circle/white X for a mapped `former_member`.

Use the current ChapterOrg for current Members and the last ChapterOrg for former
Members, matching Vanguard's former-inclusive association semantics. Authorize
against that chapter using the endpoint's current policy. Replace active-only
filters and current-association-only joins that otherwise exclude former members;
return the former member's last chapter ID/name. Do not grant access through every
historic chapter or include transferred current Members under their old chapter.
Members with no resolvable chapter are outside this chapter-based list.

This intentionally broadens status eligibility in the unreleased chapter endpoint.
Document the target behavior in OpenAPI and
add regression tests for both endpoints; do not silently retain active-only behavior
for one of them. Preserve all other route/response/access behavior. No unrelated
Member API is in scope for this roster change.

### Implement whole-roster conditional GETs

Support `ETag` / `If-None-Match` on both member-list endpoints. On the flat initial
request (no cursor/snapshot ID), validate the entire live authorized collection:
return 304 without a body when unchanged; otherwise return 200 with a new ETag and
the first page of a fresh snapshot. A change on any page must invalidate the tag.
Desktop retains the complete list/ETag across groups and contacts Vanguard on every
drill-down. It enables actions only after a 304 or complete replacement download.

Follow chunk 1's weak semantic whole-roster validator contract: exclude transient
pagination metadata, include all Member/mapping/role/chapter/permission dependencies,
authorize before 304, and generate the tag and changed response from a consistent
view. Revalidation must not rely on an expired snapshot. Use private, revalidated
responses and explicit client memory storage, never a persisted HTTP body cache.

A deterministic digest of the complete projection is the baseline; reuse a cheaper
reliable revision source only if it covers all dependencies. This saves wire bytes
even if the query/serialization still runs. Benchmark 4,000/8,000 records; do not
introduce broad revision tracking solely to optimize tag generation.

Clear the cache on OAuth disconnect, identity/provider changes, data erasure, or
process exit, not ordinary group navigation. Failed validation keeps prior data
unavailable for actions; authorization denial clears inaccessible data. After any
mapping write attempt, invalidate the old roster tag so locally patched data is
never conditionally reused as its original representation. No mapping-write ETags,
version headers, or operation receipts are reintroduced.

### Provide mapping operations for manual and proposed links

Implement or complete the chunk 1 mapping resource contract:

- `GET /api/v1/signal/members/:member_id/mapping`: current mapping,
  including `aci: null` for an authorized unmapped Member.
- `PUT /api/v1/signal/members/:member_id/mapping`: link/replace with
  `{ "aci": "<Signal ACI>", "source": "manual_assignment" }` (or the documented
  confirmed-lookup provenance for reviewed proposals).
- `DELETE /api/v1/signal/members/:member_id/mapping`: unlink and return the cleared state.

PUT/DELETE require delegated `api:write` +
`signal_mappings:write`, and current explicit `signal_mapping:write` permission
within member visibility. Apply these checks to former members too. Reads require
the mapping-read scope/permission. Audit the OAuth actor and enforce cardinality
and ordinary uniqueness constraints; see chunk 1 for exact responses/errors.
No idempotency keys/receipts, mapping-write ETags, mapping revisions, or mandatory version checks
are required. Overlapping valid edits use last-write-wins behavior. After a lost
response, Desktop rereads current state and lets the user explicitly retry if
needed; no automatic mapping-write replay or receipt store is planned.

Proposed Matches bulk processing uses these individual operations with bounded
concurrency and per-item outcomes, not an atomic batch or a new bulk endpoint.
No action changes Signal membership. Group disconnect/OAuth disconnect must not
clear these shared mappings. Vanguard need not store group connection flags or
Signal group rosters.

### Validation required for this revision

- Existing OAuth connect/reconnect/refresh/revocation tests continue to pass.
- Context returns identity/capabilities only, with no roster descriptors, Members,
  or supported `include_rosters` parameter. Remove tests expecting roster-bearing
  context and cover the single revised contract.
- New flat visibility uses `member:show`, including ancestor grants, overlapping
  chapters, denied chapters, and narrow Unit/District grants.
- Both list endpoints include former/on-leave members; last-chapter authorization,
  transfers, missing chapters, and the existing chapter response/access policy work.
- Member projection, ACI/null, role formatting, ChapterOrg STI associations,
  national null fields, excluded Unit/District roles, and field restrictions work.
- Exercise 4,000/8,000-member lists, loaded/total progress, page retry without
  duplicates, disabled linking until complete, and searching/selecting final-page
  Members in the virtualized dropdown.
- Pagination is complete and permission changes/expiry cannot appear as an empty
  roster. Every drill-down revalidates; connect and group toggles fetch no Members.
- Unchanged revalidation returns 304 without Member pages; later-page changes
  invalidate the whole-roster tag. Cover all dependency changes, permission loss,
  304 without a local body, atomic complete replacement, and failed-validation UI.
- Verify that tag generation and replacement pages describe the same snapshot,
  and that attempted mapping writes invalidate the retained tag.
- Simple mapping set/clear, current-state reads after lost responses, explicit
  user retries, permission loss, conflict disclosure,
  and partial bulk success are covered; both member-list endpoint options work.
- Desktop group flags survive restart and clear durably on disconnect/account
  change, including offline revocation and late responses. Member data is not
  persisted; leaving the view retains the complete roster/tag, and account teardown
  clears them. Incomplete replacement downloads never replace the complete cache.

These are planned acceptance checks, not tests run by this documentation revision.

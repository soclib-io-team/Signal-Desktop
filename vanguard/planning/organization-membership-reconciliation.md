# Organization membership reconciliation

## Purpose

Add an admin-assisted workflow to Signal Desktop that compares a chosen Signal
group with an external organization's membership roster. The admin can review
matches, save or correct identity mappings in the external service, remove group
members, and add organization members to the group.

This document divides the work into implementation chunks. Each chunk should get
its own detailed design before implementation. It assumes a custom Desktop build;
acceptance into official Signal is a separate decision.

## Scope and design constraints

- **Minimize changes to upstream Signal-Desktop code.** This is a fork that must
  regularly rebase onto upstream with as few conflicts as possible.
  - Put all integration code (services, state, components, IPC handlers, SQL
    helpers, styles, tests, etc.) in new files under dedicated folders named
    `vanguard`, e.g. `ts/vanguard/`, `app/vanguard/`, `ts/test-node/vanguard/`.
  - Put non-code project material (planning and design docs, notes, scripts) under
    the top-level `vanguard/` folder, e.g. these docs in `vanguard/planning/`.
  - Edit existing upstream files only where unavoidable: registering or loading
    Vanguard modules (imports, reducers, IPC channels, preload exposure, routes,
    migrations) and adding entry-point UI such as a button or menu item. Such an
    edit should be a small hook that delegates to Vanguard code; the flow itself
    must live in the Vanguard folders.
  - Prefer extension points, wrappers, and composition over modifying upstream
    logic. Do not refactor, reformat, rename, or move upstream code. If an upstream
    function must be reused but is not exported or awaitable, make the smallest
    possible change and note it.
  - Every upstream-file edit must be justified in the chunk's detailed design.
    This constraint overrides the placements suggested under
    [Expected code touchpoints](#expected-code-touchpoints).
- The operator must be a Signal group admin and have the required permissions in
  the external service. Recheck permissions when applying changes.
- Use Signal's ACI (account identifier) as the primary portable identity mapping.
  An ACI identifies an account, not a verified person. Do not export local Desktop
  conversation IDs as Signal identities.
- Keep PNI (phone-number identifier) distinct from ACI. Pending invitations can
  require different identity handling from full group members.
- Phone numbers and supplied usernames support discovery. They are not permanent
  identity keys, and privacy settings can prevent phone-number discovery.
- An unmatched group member is not necessarily an unauthorized member. Failed,
  incomplete, or ambiguous lookups must not become removal recommendations.
- Changes are explicitly selected and reviewed by an admin. Unattended background
  synchronization and automatic removal are outside the initial scope.
- Reuse existing Signal group operations and protocol handling. No Signal server
  or protocol changes are expected.
- Store identity mappings separately from group membership. Removing an account
  from one group does not automatically delete its organization identity mapping.
- Treat exporting organization-to-Signal identity associations as an explicit
  disclosure. Do not export messages, unrelated contacts, or cryptographic keys.

## Delivery sequence

| Chunk | Deliverable                                      | Dependencies |
| ----- | ------------------------------------------------ | ------------ |
| 1     | Provider contract and identity model             | None         |
| 2     | Connection, authentication, and account settings | 1            |
| 3     | External roster API and browsing UI              | 1, 2         |
| 4     | Group comparison and proposed matches            | 3            |
| 5     | Manual mapping and conflict resolution           | 4            |
| 6     | Reviewed group removals and operation recovery   | 4, 5         |
| 7     | Additions, invitations, and mapping persistence  | 5, 6         |
| 8     | End-to-end hardening and pilot rollout           | 2–7          |

Testing belongs in every chunk. Chunk 8 validates the integrated workflow rather
than deferring testing until the end.

## 1. Provider contract and identity model

Detailed design: [Vanguard provider contract and identity model](chunk-1-vanguard-contract.md).

**Outcome:** Agree on the data and API capabilities before building the connector.

Work:

- Identify the external service, authentication mechanism, API permissions,
  pagination, rate limits, and supported mapping storage.
- Define stable provider, organization, roster, and person identifiers. Specify
  how active membership, departures, guests, and multiple rosters are represented.
- Define organization/person-to-ACI mappings, with provenance, verification time,
  and version information for conflicting updates.
- Decide whether one person may map to multiple Signal accounts and how duplicate
  person records or conflicting account assignments are resolved.
- Define the separate association between a roster and a Signal group, including
  whether that association is local or shared between administrators.
- Specify a provider adapter for fetching complete rosters and reading, saving,
  correcting, and deleting identity mappings. Require safe retry behavior and
  concurrency protection for writes, or define how to supply them.
- Decide which data is authoritative remotely, cached locally, retained for
  recovery, and cleared on disconnect or Signal-account change.
- Decide whether a companion backend is needed. The default is a direct Desktop
  connector; a backend may be necessary for confidential credentials or mapping
  storage the provider cannot support.

Completion criteria:

- A documented contract, example responses, identity rules, and permission model
  cover the later workflows.
- Provider limitations and any required backend are explicit.

## 2. Connection, authentication, and account settings

Implementation: [Chunk 2 OAuth connection and account settings](chunk-2-oauth-connection.md).
DevOps: [Vanguard OAuth deployment setup](../operations/oauth-setup.md).

**Outcome:** An admin can connect, inspect, and disconnect their external account.

Backend/main-process work:

- Implement login, callback validation, token refresh, expiration, and logout.
- If OAuth is supported, use Authorization Code + PKCE in the system browser.
  Do not embed a confidential client secret in Desktop.
- Keep tokens and external HTTP requests behind a narrow, validated Electron IPC
  interface. Validate configured service destinations.
- Protect persisted tokens using available secure storage; define behavior when
  secure storage is unavailable instead of silently persisting plaintext secrets.
- Expose the connected account, organization access, and relevant capabilities.

Frontend work:

- Add connection settings with login progress, connected identity, permissions,
  reconnect, and disconnect states.
- Explain what identity data the integration will send to the external service.
- Handle cancellation, revoked access, expired sessions, and provider outages.

Completion criteria:

- Login, restart, refresh, reconnect, and disconnect work without exposing tokens
  to UI state or logs.
- An account without write permission is clearly limited to permitted actions.

## 3. External roster API and browsing UI

**Outcome:** The admin can select and inspect the organization roster independently
of making any Signal changes.

Service work:

- Implement organization/roster selection and complete paginated member reads.
- Validate responses and normalize phone numbers using existing utilities.
- Preserve source identifiers, membership status, and available identity mappings.
- Track snapshot completeness, retrieval time, and version where available.
- Handle retries, rate limits, cancellation, and stale cached data explicitly.

Frontend work:

- Add roster browsing with search and useful membership filters.
- Show organization identity, available phone/Signal identity information, and
  loading, empty, incomplete, stale, and error states.
- Make a complete empty roster distinguishable from a failed or partial response.

Completion criteria:

- Large and paginated rosters display correctly.
- Partial fetches and missing permissions cannot look like a complete roster.

## 4. Group comparison and proposed matches

**Outcome:** A read-only reconciliation screen explains how the selected roster
corresponds to a chosen Signal group.

Service work:

- Snapshot current full members, pending invitations, join requests, and relevant
  group permissions/revision.
- Build a reconciliation engine independent of UI components.
- Match existing ACI mappings first. Use available phone information and bounded,
  user-initiated discovery through existing Signal lookup facilities for proposals.
  Support supplied usernames without assuming group members expose usernames.
- Classify matched entries, unmapped group members, organization members missing
  from the group, inactive mapped members, pending invitations, conflicts, and
  unresolved lookups.
- Preserve match evidence and uncertainty. Never resolve ambiguous identities by
  display name alone or silently replace a conflicting saved mapping.

Frontend work:

- Add a reconciliation entry point in group details for admins.
- Let the admin choose the roster, review categories, inspect match evidence,
  refresh the comparison, and leave entries unresolved.

Completion criteria:

- Comparison makes no external mapping writes or group membership changes.
- Hidden numbers, duplicate records, stale identities, and failed discovery have
  explicit, non-destructive outcomes.

## 5. Manual mapping and conflict resolution

**Outcome:** The admin can connect an existing Signal group account to the correct
organization person and persist that association externally.

Service work:

- Implement mapping creation, correction, and unlinking through the provider
  adapter, with validation, concurrency checks, and safe retries.
- Save the ACI and verification provenance. Only save phone information when it
  is available and appropriate under the agreed contract.
- Detect duplicate/conflicting assignments and require explicit resolution.
- Refresh the affected records after writes and reconcile local caches.

Frontend work:

- Provide person search and a side-by-side identity review before saving.
- Show exactly which identity fields will be written externally.
- Distinguish saved, pending, conflicting, and failed changes. Allow retry and
  correction without changing Signal group membership.

Completion criteria:

- Mappings survive a fresh fetch and are available to other authorized admins
  through the external service.
- Concurrent edits cannot silently overwrite another admin's mapping.

## 6. Reviewed group removals and operation recovery

**Outcome:** The admin can remove selected group members and recover from partial
execution without repeating completed changes.

Service work:

- Introduce a durable operation journal for reviewed actions and their outcomes,
  scoped to the Signal account, group, and external organization.
- Refresh relevant group/roster state and permissions before execution. If the
  reviewed facts change materially, request a new review.
- Reuse existing group removal logic, with awaitable results and post-operation
  membership checks. Serialize mutations as required by group revision handling.
- Model full-member removal, invitation cancellation, and join-request denial as
  distinct actions; only expose those included in the detailed design.
- Preserve identity mappings when removing group membership.
- Record per-action success, failure, and uncertain outcomes. On restart or
  timeout, inspect actual state before retrying; do not automatically replay stale
  destructive actions.

Frontend work:

- Allow explicit selection and review of removals, with account identities and
  relevant membership/mapping context.
- Provide progress, cancellation of work not yet started, and per-person results.
- Account for self-removal and administrator removal in the detailed design.

Completion criteria:

- Incomplete roster data cannot drive removals.
- Permission changes, concurrent group edits, timeouts, and restart recovery do
  not cause silent or duplicate actions.

## 7. Additions, invitations, and mapping persistence

**Outcome:** The admin can select organization members to add and see both the
Signal membership outcome and external mapping outcome.

Service work:

- Resolve selected people to usable Signal identities using existing contact
  discovery and conversation facilities. Offer manual resolution where needed.
- Reuse existing add-member logic, profile-credential handling, and group updates.
- Check capacity, existing membership, pending invitations, and banned accounts.
  Existing add logic can unban an account; expose that consequence for review.
- Extend the operation journal to track identity resolution, Signal mutation,
  and external mapping persistence separately.
- Define write ordering and recovery before implementation. Signal and the
  external service cannot commit atomically.
- Reconcile actual outcomes after mutation. Persist a verified ACI mapping when
  available; represent unresolved/pending identities without mislabeling a PNI as
  an ACI. Distinguish an invitation from completed membership.
- If Signal succeeds but mapping persistence fails, retry the mapping write
  without repeating the addition. Avoid automatic compensating removals.

Frontend work:

- Provide selection, identity review, and an additions preview.
- Display outcomes such as joined, invited, unresolved, failed, or mapping save
  pending. An identity mapping alone must not imply successful group membership.

Completion criteria:

- Direct additions and invitations are correctly distinguished.
- Either system can fail independently without hiding partial success or losing
  the information required for recovery.

## 8. End-to-end hardening and pilot rollout

**Outcome:** The complete workflow is ready for a controlled pilot.

Work:

- Test with the project's mock-server, Electron, and unit-test facilities as
  appropriate, plus a test external service and designated test Signal groups.
- Cover privacy-restricted discovery, changed/reassigned numbers, replaced
  accounts, duplicate mappings, guests, former members, and pending invitations.
- Cover pagination failures, capacity/rate limits, expired credentials, revoked
  permissions, concurrent admins, interrupted writes, and process restarts.
- Verify accessibility, localization, large-roster performance, and clear errors.
- Review IPC boundaries, token persistence, redacted logging, exported data, and
  cache/journal retention and cleanup.
- Keep external API versioning behind the adapter and document custom-build
  maintenance, packaging, and update requirements.
- Pilot read-only comparison and mapping first, then enable reviewed membership
  mutations after validating recovery behavior.

Completion criteria:

- The critical identity and partial-failure scenarios have meaningful automated
  coverage and a documented manual acceptance checklist.
- Pilot administrators can explain each proposed action and distinguish completed
  work from pending or failed work.

## Expected code touchpoints

These are starting points for detailed design, not commitments to exact placement.

| Area                                   | Existing code                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Group details and member UI            | `ts/components/conversation/conversation-details/`                                              |
| State and connected components         | `ts/state/ducks/`, `ts/state/smart/`                                                            |
| Group action entry points              | `ts/state/ducks/conversations.preload.ts`                                                       |
| Group mutation and credential handling | `ts/groups.preload.ts`                                                                          |
| Conversation membership operations     | `ts/models/conversations.preload.ts`                                                            |
| Account discovery                      | `ts/util/lookupConversationWithoutServiceId.preload.ts`, `ts/util/getServiceIdsForE164s.dom.ts` |
| Identity types                         | `ts/types/ServiceId.std.ts`, `ts/model-types.d.ts`                                              |
| Connector and reconciliation services  | New modules alongside `ts/services/`                                                            |
| Main-process authentication and IPC    | `app/`, relevant preload/context interfaces                                                     |
| Local cache and operation journal      | `ts/sql/` and migrations, if persisted there                                                    |
| Validation                             | `ts/test-node/`, `ts/test-electron/`, `ts/test-mock/`, Storybook                                |

## Dependencies and unresolved decisions

- Reuse existing React/Redux, HTTP facilities, Zod, and phone-number utilities.
  No new library is inherently required for roster browsing or comparison.
- An OAuth/OIDC library may be needed once the provider and supported flow are
  known. Select and review it during chunk 2; do not implement a bespoke protocol.
- A provider SDK is optional and should be justified against a small typed adapter.
- Electron `safeStorage` is already available, but secure-backend availability
  requires explicit handling.
- A companion backend depends on provider authentication and mapping-storage
  capabilities; it is not assumed to exist.
- Before implementation, settle the provider, roster eligibility rules, mapping
  cardinality, guest exceptions, identity verification expectations, shared group
  associations, and external audit/retention requirements.

## Reference material

- [Signal phone-number privacy and usernames](https://support.signal.org/hc/en-us/articles/6712070553754-Phone-Number-Privacy-and-Usernames)
- [Signal group management](https://support.signal.org/hc/en-us/articles/360050427692-Manage-a-group)
- [Signal group capabilities and limits](https://support.signal.org/hc/en-us/articles/360007319331-Group-chats)
- [OAuth for native applications (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

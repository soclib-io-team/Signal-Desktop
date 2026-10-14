# Organization membership reconciliation

## Purpose

Add a Vanguard connection and group-management workflow to Signal Desktop.
OAuth connects the account without fetching Members. The user marks Signal groups
as connected, then opens them under Settings > Vanguard to fetch a fresh flat
Members list, review Signal identities, and link or unlink mappings in Vanguard.
Proposed Matches follows immediately after this core workflow. Reviewed additions
and removals are later implementation steps.

This document divides the work into implementation chunks. Each chunk should get
its own detailed design before implementation. It assumes a custom Desktop build;
acceptance into official Signal is a separate decision. Desktop and Vanguard
provider changes are unreleased; there are no older clients to support.

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

| Chunk | Deliverable                                               | Dependencies |
| ----- | --------------------------------------------------------- | ------------ |
| 1     | Provider contract and identity model                      | None         |
| 2     | Connection, authentication, and account settings          | 1            |
| 3     | Connected groups, fresh Members API, and group drill-down | 1, 2         |
| 4     | Manual Link/Unlink and mapping conflict resolution        | 3            |
| 5     | Proposed Matches and selected bulk linking                | 3, 4         |
| 6     | Reviewed group removals and operation recovery            | 3–5          |
| 7     | Additions, invitations, and mapping persistence           | 5, 6         |
| 8     | End-to-end hardening and pilot rollout                    | 2–7          |

Testing belongs in every chunk. Chunk 8 validates the integrated workflow rather
than deferring testing until the end.

## 1. Provider contract and identity model

Detailed design: [Vanguard provider contract and identity model](chunk-1-vanguard-contract.md).

**Outcome:** Agree on the data and API capabilities before building the connector.

Work:

- Preserve Vanguard OAuth and define the additive flat-list contract, API
  permissions, pagination, rate limits, and mapping storage.
- Define stable provider, organization, roster, and person identifiers. Specify
  how active membership, departures, guests, and multiple rosters are represented.
- Define organization/person-to-ACI mappings, with provenance and verification time.
- Keep zero or one ACI per Member; settle reverse uniqueness and how duplicate
  person records or conflicting account assignments are resolved.
- Persist a local connected-to-Vanguard flag for each selected Signal group;
  there is no ChapterOrg/roster selection or group-to-roster association.
- Specify a provider adapter for fetching complete rosters and reading, saving,
  correcting, and deleting identity mappings. Use simple set/clear writes and
  reread current state after uncertain outcomes; no write-receipt infrastructure.
- Decide which data is authoritative remotely, cached locally, retained for
  recovery, and cleared on disconnect or Signal-account change.
- Call Vanguard directly; Vanguard owns mapping persistence. No companion backend
  or confidential Desktop client secret is required.

Completion criteria:

- A documented contract, example responses, identity rules, and permission model
  cover the later workflows.
- Provider limitations and any required backend are explicit.

## 2. Connection, authentication, and account settings

Implementation: [Chunk 2 OAuth connection and account settings](chunk-2-oauth-connection.md).
DevOps: [Vanguard OAuth deployment setup](../operations/oauth-setup.md).

**Outcome:** An admin can connect, inspect, and disconnect their external account.

Backend/main-process work:

- Preserve implemented login, callback validation, refresh, expiration, and logout.
- Keep Authorization Code + PKCE in the system browser.
  Do not embed a confidential client secret in Desktop.
- Keep tokens and external HTTP requests behind a narrow, validated Electron IPC
  interface. Validate configured service destinations.
- Protect persisted tokens using available secure storage; define behavior when
  secure storage is unavailable instead of silently persisting plaintext secrets.
- Expose the connected account and relevant capabilities without fetching Members
  or inspecting per-ChapterOrg rosters. `/api/v1/signal/context` returns only
  identity/capabilities, never roster descriptors, and has no `include_rosters`
  option. Obtain Member rosters only through the two member-list endpoints.

Frontend work:

- Add connection settings with login progress, connected identity, permissions,
  reconnect, and disconnect states.
- Explain what identity data the integration will send to the external service.
- Handle cancellation, revoked access, expired sessions, and provider outages.

Completion criteria:

- Login, restart, refresh, reconnect, and disconnect work without exposing tokens
  to UI state or logs.
- An account without write permission is clearly limited to permitted actions.

## 3. Connected groups, fresh Members API, and group drill-down

**Outcome:** Settings > Vanguard lists the Signal groups the user has connected;
opening a group fetches current Vanguard data and displays its Signal users.

Group settings and entry points:

- In the Signal Group view's `...` menu, show **Connect to Vanguard** when the
  group is disconnected, otherwise **Disconnect from Vanguard**. Only show these
  options when an OAuth connection exists; retain the plan's Signal-admin checks.
- Persist the flag through Signal's existing local conversation/group-settings
  datastore and update mechanism, using a minimal hook into Vanguard-owned code.
  Scope it to the Signal account, provider, and Vanguard user. No new Signal
  protocol field or cross-device/admin synchronization is implied.
- Marking a group connected does not fetch Members or select a ChapterOrg.
- OAuth disconnect persistently clears all flags for that connection, cancels
  requests, and discards in-memory data even if remote revocation fails. Group
  disconnect clears only that group's flag; neither action deletes mappings.
- A temporary outage or same-account reconnect does not clear group flags.
  Switching Vanguard/Signal accounts clears the previous connection's flags.
- Under Settings > Vanguard, show **Groups connected to Vanguard** only while
  connected. Initially empty, each row shows the current Signal group name,
  current member count, and **Disconnect** button. Clicking the row drills down;
  clicking Disconnect must not also navigate. Counts come from Signal.

Member fetching and drill-down:

- On every group entry/re-entry, create a new request for the flat Members list
  across ChapterOrgs authorized by `member:show`. Fetch all pages before treating
  absence as unmapped. Include candidates, full members, members on leave, and
  former members (last ChapterOrg), plus mappings and the filtered user roles
  specified in chunk 1. Never enumerate/fetch per-ChapterOrg rosters in Desktop.
- Keep the fetched data in memory only for the current view. Discard it on exit,
  disconnect, or account change; ignore late responses using generation checks.
  Do not reuse a previous drill-down's snapshot or persist Member data in Signal.
  A short-lived provider pagination snapshot is not a Desktop cache. Roster GET
  ETags may be evaluated as a bandwidth optimization separately from mapping
  writes (see chunk 1). They do not eliminate re-entry downloads when the prior
  response body has been discarded; retaining it across visits is not yet planned.
- Automatically fetch all pages at an initial page size of 1,000 (normally 4–8
  requests for the expected 4,000–8,000 Members). Show progress such as “Loading
  members: 3,000 of 8,000”. Enable linking and Proposed Matches only after every
  page succeeds and the terminal cursor confirms completion.
- Show explicit loading, failed, incomplete, and retry states. Retry a transiently
  failed page against the same valid snapshot without duplicating entries; on
  snapshot expiry/invalidation discard partial data and restart. A failed/partial
  read must not render users as definitively unmapped or enable linking.
- For each current Signal group user, show their nickname, falling back to their
  profile name, and an Actions dropdown. Join using ACI, never display name.
- Show a green circle/checkmark for a mapped Member whose status is not
  `former_member`, a red circle/white X for a mapped former member, and an orange
  circle/question mark when no authorized mapping is found. Provide accessible
  text labels. Orange is unresolved within visibility, not proof no mapping exists.
- Pending invitations lacking an ACI remain unresolved and cannot be linked as
  though their PNI were an ACI. No discovery or automatic mapping occurs on entry.

Completion criteria:

- Group flags survive restart; OAuth disconnect clears them durably.
- Every drill-down fetches fresh data, including when revisiting the same group.
- Empty, partial, inaccessible, and failed data are distinguishable, and all three
  status indicators, names, counts, and account-isolation behavior are tested.

## 4. Manual Link/Unlink and mapping conflict resolution

**Outcome:** The user saves or clears Signal-user-to-Member associations in Vanguard.

- Actions shows **Unlink** only for a mapped user and **Link** only for an unmapped
  user. Disable writes with an explanation when OAuth scopes or current explicit
  mapping permission do not allow them; visibility alone never authorizes writes.
- Unlink clears the Member's mapping through the provider DELETE endpoint. It
  does not remove the user from Signal and affects that mapping in every group.
- Link opens a modal with a dropdown of all loaded authorized Members, labelled
  `full_name (chapter_org_name)`. Selecting a Member closes the dropdown and shows
  full name, chapter name, and roles (`role_name`, `chapter_org_name`); national
  roles show “National” for their null chapter. Empty roles show an empty state.
- Make the dropdown searchable across the full in-memory list by member/chapter
  name and virtualize its options so only visible rows render. Preserve keyboard
  navigation and accessible selection; searching must not fetch another API page.
- **Confirm** persists the selected Member/ACI through the provider PUT endpoint;
  **Cancel** closes without a write. Existing conflicting mappings must never be
  silently replaced or stolen; show the conflict and require separate resolution.
- Use ordinary PUT/DELETE requests with current server authorization as specified
  in chunk 1. No idempotency keys, mapping-write ETags, or mandatory version checks are required.
  Refresh affected live state after writes or uncertain responses; if it differs
  from the intended result, show that state and let the user retry explicitly.

Completion criteria:

- Link/Unlink survives a fresh drill-down and is visible to authorized other admins.
- Database uniqueness rejects duplicate assignments. Rare overlapping valid edits
  use last-write-wins behavior; no optimistic concurrency workflow is required.
- Member details, roles, permission failures, and retry behavior are covered.
- Verify full-list search, keyboard selection, and responsive virtualized rendering
  with 8,000 Members, including records loaded from the final page.

## 5. Proposed Matches and selected bulk linking

**Outcome:** Immediately after chunks 2–4, users can review proposed matches and
save selected mappings without adding or removing Signal group members.

- Place **Proposed Matches** above the Signal-user list in the same drill-down.
- Build proposals from the freshly loaded Members and current group state. Use
  available phone evidence and bounded user-initiated Signal discovery where
  needed. Never infer identity from display names alone; preserve evidence and
  uncertainty. Do not propose already-linked or conflicting assignments as safe.
- Each proposal shows both identities, chapter, and supporting evidence with a
  checkbox. Start unchecked; allow selection/deselection. Keep ambiguous or
  unresolvable candidates outside the actionable selection.
- Below the section, show **Link Signal users to members**, disabled when none
  are selected or writes are unavailable. Clicking processes only selected pairs
  using the simple mapping PUT contract with bounded concurrency and per-item
  outcomes. A new bulk endpoint is unnecessary initially.
- Enforce current server permissions on each write and prevent duplicate
  ACI/Member selection. No per-item version preflight is required.
- Report each success, conflict, failure, and uncertain result. Reread mappings
  after uncertain responses and show current state. Users may explicitly retry
  unresolved items; do not automatically replay writes or resubmit completed items.
  Refresh indicators and clear resolved proposals/selections after processing.
- Leaving the view or disconnecting stops work not yet started. In-flight writes
  may already have committed; a subsequent fresh read resolves actual state.

Completion criteria:

- Only explicitly selected proposals are linked; no Signal membership changes occur.
- Partial success, current-state reads after lost responses, unavailable numbers, ambiguous
  matches, cancellation, and lost responses have tested, visible outcomes.

## 6. Reviewed group removals and operation recovery

**Outcome:** The admin can remove selected group members and recover from partial
execution without repeating completed changes.

Service work:

- Introduce a durable operation journal for reviewed actions and their outcomes,
  scoped to the Signal account, group, and Vanguard issuer/user.
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
- Keep the existing `oauth4webapi` integration in chunk 2.
- A provider SDK is optional and should be justified against a small typed adapter.
- Electron `safeStorage` is already available, but secure-backend availability
  requires explicit handling.
- Vanguard provides authentication and mapping storage; no companion backend is needed.
- Vanguard is the provider; `member:show` defines flat-list chapter visibility.
  Former members are included through their last chapter. Group flags are local,
  mappings are shared through Vanguard, and Member lists are memory-only.
- Finalize reverse-ACI uniqueness, mapping permission grants, guest exceptions,
  evidence standards, and external audit/retention requirements before rollout.

## Reference material

- [Signal phone-number privacy and usernames](https://support.signal.org/hc/en-us/articles/6712070553754-Phone-Number-Privacy-and-Usernames)
- [Signal group management](https://support.signal.org/hc/en-us/articles/360050427692-Manage-a-group)
- [Signal group capabilities and limits](https://support.signal.org/hc/en-us/articles/360007319331-Group-chats)
- [OAuth for native applications (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

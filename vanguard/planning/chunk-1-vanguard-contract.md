# Chunk 1: Vanguard provider contract and identity model

Status: revised contract for unreleased Desktop and provider code. Vanguard has
implementation in progress; there are no older clients or compatibility paths to
support. Preserve useful implemented code while revising it to this contract.

Parent plan: [Organization membership reconciliation](organization-membership-reconciliation.md).

## Outcome and scope

Define the Vanguard APIs, identity model, authorization rules, and data semantics
needed by Signal Desktop. This is a design document, not an implementation of
either application. OAuth UX, roster UX, and group mutation UX remain in subsequent
chunks.

Vanguard will be both the OAuth provider and the authoritative store for member
records and Signal mappings. Desktop calls Vanguard directly using delegated user
access. No separate integration backend is currently needed: the necessary new
storage and endpoints can live in Vanguard's existing Rails application.

## Confirmed requirements

- Return members scoped to the requesting user's authorized visibility. A local
  leader may see fewer members than an administrator.
- Each member includes the explicit API Member projection, `full_name`, nullable
  Signal ACI, `chapter_org_name`, and filtered `user_roles` described below.
- Flat member visibility uses `member:show` over ChapterOrgs, including descendants
  covered by a permission grant; a Unit/District grant does not expose its parent
  chapter. Include former members through their last ChapterOrg in all member
  listing endpoints, including the existing per-ChapterOrg endpoint.
- Expose a dictionary relating Vanguard member IDs to Signal ACIs.
- Each member has zero or one ACI. Setting a new ACI replaces the old mapping;
  dropping the mapping leaves the member unmapped.
- Reading or changing mappings does not itself add or remove anyone from Signal.

## Repository findings

Inspected the local `../vanguard` checkout, whose origin is
`git@github.com:soclib-io-team/vanguard.git`, at commit
`95237c62fd5432f39066a3c6a32c5a382f526a83`. The GitHub page could not be fetched by
the web tool. The following table is historical baseline evidence, not the revised target or a
verified production deployment. OAuth/context prerequisites are now implemented;
chunk 2 describes the changes required on top of them. Existing unrelated working-tree changes were not modified.

| Existing capability                                | Findings and implications                                                                                                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/chapter_orgs/:chapter_org_id/members` | Already returns `id`, `user_id`, `email`, `first_name`, `last_name`, `phone_number`, `status`, `chapter_org_id`, `unit_ids`, and `district_ids`. Requires `api:read`, `members:read`, and a user principal.                                  |
| Roster authorization                               | `ChapterOrgMembersPolicy` permits the caller's own chapter plus permission-granted organizational subtrees. Ordinary chapter membership can grant roster access. This is not automatically the desired leader/admin policy.                  |
| Admin semantics                                    | Existing roster tests explicitly show that admin status alone is not a bypass. New reconciliation admin permissions must be deliberately defined and tested.                                                                                 |
| Roster eligibility                                 | Uses `Member.active_members`: candidates/full members with no membership end date, excluding members on leave, plus a current chapter assignment. Former members are absent.                                                                 |
| Current roster response                            | Unpaginated `{ members: [...] }`; no cross-request snapshot contract. Current unit/district IDs are already derived without per-member queries. Districts include direct memberships and indirect membership through units.                  |
| Phone numbers                                      | `Member#phone_number` presents US/PR numbers as local numbers. The API must not promise E.164 by copying that getter unchanged.                                                                                                              |
| Organization directory                             | `GET /api/v1/chapter_orgs` returns active chapter metadata, not a list of rosters the caller can reconcile. Directory visibility is not member-data authorization.                                                                           |
| Caller profile                                     | `GET /api/v1/me` returns member/profile and role information. It lacks a dedicated reconciliation capability contract.                                                                                                                       |
| Leadership                                         | Domain data exists in leadership-body configs, unit/district lead configs, and unit/district liaison configs. `MemberLeadershipPresenter` is useful background, but is a UI presentation layer and does not cover every association.         |
| OAuth/OIDC                                         | Doorkeeper and doorkeeper-openid_connect are installed. Non-confidential clients must use PKCE; refresh tokens are enabled. Login requires the existing authenticated/2FA session. Discovery and public-client PKCE integration tests exist. |
| Signal mapping                                     | No mapping route is present in the inspected API route set. New persistence, policies, and endpoints are required.                                                                                                                           |

Primary source paths in Vanguard:

- `config/routes.rb`
- `app/controllers/api/v1/chapter_org_members_controller.rb`
- `app/controllers/api/v1/{core,base,chapter_orgs,me}_controller.rb`
- `app/policies/{chapter_org_members_policy,chapter_org_api_scope,member_policy}.rb`
- `app/models/member.rb` and the leadership/configuration models
- `app/presenters/member_leadership_presenter.rb`
- `config/initializers/{doorkeeper,doorkeeper_openid_connect}.rb`
- `config/permissions.yml`
- `docs/openapi/v1/openapi.yaml`
- `test/integration/api/v1/chapter_org_members_test.rb`
- `test/integration/oauth_oidc_pkce_flow_test.rb`

## Endpoint strategy: reuse logic, add a reconciliation API

Preserve `GET /api/v1/chapter_orgs/:chapter_org_id/members` as the per-chapter
option. Add `GET /api/v1/signal/members` as the flat-list option and the default
for Signal Desktop. Separate collection endpoints make client choice explicit:
use the chapter path for a chapter roster, the Signal path for the full authorized
list. Do not implement the flat option by making one request per chapter.

Keep the existing endpoint's route, response envelope, fields, and access rules.
The intentional eligibility change is to include former members using their last
ChapterOrg; current members on leave must also remain visible. Document this
eligibility rule and test it. Reuse query/serialization logic where appropriate
without discarding the existing implementation. Retain the chapter endpoint as
an intentional API option, not as an older-client compatibility requirement.

## Authorization and visibility contract

The flat list includes Members of every ChapterOrg within the caller's current
`member:show` jurisdiction, with no additional `member:index` requirement. Resolve
permission grants through the organizational tree, not role names, admin status,
or management-scope shortcuts. A grant covering a chapter includes its Members;
a narrower Unit/District grant does not grant the whole chapter.

Mapping reads additionally require `signal_mapping:read`; mapping writes require
`signal_mapping:write` over the member as well as member visibility. Apply existing
role-field authorization (`member:show_roles`) to expansions; expose restricted
roles explicitly instead of pretending none exist. Configure intended operator
grants accordingly. OAuth scope possession never grants these permissions.

Every request must satisfy all applicable layers:

1. Valid delegated bearer token tied to a current Vanguard user. Reject app-only
   `client_credentials` tokens for this workflow.
2. Required OAuth scopes for the endpoint.
3. Current Vanguard policy permission over each returned or modified member.
4. Endpoint selection: the flat list uses all authorized ChapterOrgs; the existing
   per-chapter endpoint retains its established policy and requested chapter.

Use one shared policy/query boundary for roster visibility and mapping visibility.
Mapping writes additionally require `signal_mapping:write`. Test the chapter
jurisdictions explicitly; do not reuse a broader management-based policy scope.

Recheck authority on every request, including snapshot pages and retried writes.
Do not encode permanent authorization in an OAuth token or a snapshot handle.
Return `404` for missing or unauthorized member resources, matching Vanguard's
non-disclosure convention. A hidden mapping must never leak through a reverse-ACI
lookup or a detailed uniqueness error.

An authorized roster can still be only a subset of a Signal group. Completing its
pagination means "complete within this visibility/filter," not "all members of
the organization." Absence must remain an unknown/unmapped result, not proof that
the person has departed or should be removed.

## Identity and persistence

Use the tuple `(Vanguard issuer, member_id)` to identify a person record outside
Vanguard. The issuer/API deployment must be explicitly paired in client config;
the GitHub repository URL is not the runtime API URL. Use opaque Vanguard IDs
without deriving identity from names or phone numbers.

Distinguish OAuth `sub` (Vanguard user ID) from member ID. Members need not have a
Vanguard login, so neither `user_id` nor `sub` is a roster mapping key.

Proposed table: `member_signal_mappings`.

| Field                  | Contract                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `member_id`            | Foreign key and unique index: one mapping resource per member.                                                                      |
| `aci`                  | Nullable PostgreSQL UUID, serialized as canonical lowercase UUID text. Reject `PNI:` values, usernames, and local conversation IDs. |
| `source`               | Controlled value such as `manual_assignment` or `confirmed_lookup`; provenance, not proof of identity.                              |
| `confirmed_at`         | Server time of the admin-confirmed assignment.                                                                                      |
| `updated_by_user_id`   | Actor obtained from the bearer token, never trusted from request JSON.                                                              |
| `oauth_application_id` | Calling client identity for audit attribution.                                                                                      |
| timestamps             | Creation/update timestamps under normal Rails conventions.                                                                          |

An absent mapping row represents an unmapped Member. Clearing may delete the row;
no revision history or optimistic-lock column is required. Retain ordinary audit
history separately and enforce one mapping per Member with a database constraint.

Provisional recommendation: also enforce a partial unique index on non-null ACI
within this Vanguard deployment. This prevents one account from silently mapping
to two people. The user has specified member-to-ACI cardinality; this reverse
uniqueness rule remains a separate decision. Return a generic conflict if the
existing owner is not visible to the caller. Never steal another member's ACI as
a side effect of replacement.

Use Vanguard's existing audit mechanism for assignment, replacement, and clearing.
Explicitly attribute API writes to the OAuth user/application; do not assume the
browser-session audit context exists in `ActionController::API`. Restrict audit
access and settle retention before rollout.

Do not update the member's canonical phone number when saving a mapping. The
requested mapping requires only ACI; phone correction is a separate Vanguard
workflow. Store neither Signal credentials nor profile/group keys in Vanguard.

## Proposed API contract

The context endpoint already exists. The flat member list and mapping endpoints
are additions; retain any implemented mapping contract rather than duplicating
it. Responses are JSON; examples use illustrative, shortened Vanguard IDs.

### Endpoint inventory

| Method and path                                    | Purpose                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/v1/chapter_orgs/:chapter_org_id/members` | Retained chapter-specific roster, with expanded status eligibility.              |
| `GET /api/v1/signal/context`                       | Caller IDs and effective capabilities only; never rosters or descriptors.        |
| `GET /api/v1/signal/members`                       | Default flat authorized Member list, inline mappings/roles, and snapshot handle. |
| `GET /api/v1/signal/mappings`                      | Member-ID-to-ACI dictionary for the same scoped snapshot.                        |
| `GET /api/v1/signal/members/:member_id/mapping`    | Current mapping, including an unmapped state.                                    |
| `PUT /api/v1/signal/members/:member_id/mapping`    | Create or replace that member's ACI mapping.                                     |
| `DELETE /api/v1/signal/members/:member_id/mapping` | Clear the mapping without deleting the Member.                                   |

No Signal group mutation endpoint belongs in Vanguard. No bulk-write, webhook,
global reverse-ACI lookup, or shared group-association endpoint is required for the
first version. They can be added later if a concrete workflow needs them.

### OAuth scopes

Reuse `api:read` and `members:read` for roster reads and introduce narrowly named
`signal_mappings:read` and `signal_mappings:write` scopes for mapping access.
Mapping writes require `api:write` plus `signal_mappings:write`; mapping reads
require `api:read` plus `signal_mappings:read`. Context requires `api:read` and
reports effective capabilities rather than granting them.

Preserve the implemented scope registrations in Doorkeeper's optional scopes,
authorization-code grant allowlist, and Desktop application allowlist. Configure write
controllers intentionally: the existing base controller defaults to `api:read`
and must not accidentally authorize writes on that basis alone.

Caller identity comes from context; Desktop does not request ID tokens or need
OIDC profile/email/phone scopes. Preserve chunk 2's implemented public-client
registration, discovery/issuer validation, callbacks, and login/refresh/revocation.
No new OAuth server gem is needed for this plan.

### Connection context and endpoint selection

Desktop requests `GET /api/v1/signal/context` at connection and capability
refresh. Return caller IDs and current effective capabilities only. Never construct
or return roster descriptors or Member collections. Remove roster fields and their
query/serialization code from the unreleased provider implementation. Do not
implement or support an `include_rosters` parameter or alternate roster-bearing
context response. Update Desktop validation and tests to the single response shape.
Capabilities are UI hints and must be enforced again on every read/write.

Desktop stores only a connected flag for a Signal group, never a selected chapter,
district, unit, or roster. Only entering a connected group's Settings drill-down
triggers `GET /api/v1/signal/members`, conditionally when a complete roster is
already retained in memory. Other API clients can explicitly choose the
existing chapter endpoint. Desktop never fetches that endpoint in this workflow.

### Flat Member listing

```http
GET /api/v1/signal/members?limit=1000
Authorization: Bearer <access-token>
```

```json
{
  "members": [
    {
      "id": "mbr_example",
      "user_id": "usr_example",
      "email": "alex@example.org",
      "first_name": "Alex",
      "last_name": "Rivera",
      "full_name": "Alex Rivera",
      "phone_number": "+12025550123",
      "status": "former_member",
      "on_leave": false,
      "chapter_org_id": "org_example",
      "chapter_org_name": "Example Chapter",
      "unit_ids": [],
      "district_ids": [],
      "signal_user_id": "70a81aac-7237-4bc1-9a72-33d055f455ab",
      "user_roles": [
        {
          "role_slug": "chapter_leader",
          "role_name": "Chapter Leader",
          "chapter_org_name": "Example Chapter",
          "chapter_org_type": "Organization"
        }
      ],
      "user_roles_restricted": false,
      "capabilities": { "manage_signal_mapping": true }
    }
  ],
  "meta": {
    "snapshot_id": "opaque-snapshot",
    "as_of": "2026-10-14T12:00:00Z",
    "visibility": "authorized_subset",
    "total_count": 1,
    "next_cursor": null
  }
}
```

Data rules:

- “Member record” means an explicit allowlisted API projection, not unrestricted
  Rails model serialization. Include the existing public member fields shown
  above plus full name, chapter name, mapping, and roles. IDs, names, and status
  are authoritative Vanguard values; optional profile/contact fields may be null.
- `signal_user_id` is the canonical Signal ACI, identical to the mapping API's
  `aci`, or null for an authorized unmapped Member.
  Do not use phone numbers, PNI, usernames, or local conversation IDs as this key.
  Require mapping-read OAuth scope and permission for this mapping-bearing list;
  reject insufficient permission explicitly rather than substituting nulls.
- `phone_number` is validated E.164 or null, normalized server-side. Invalid or
  missing phone data must not remove a Member from the response.
- Include candidates, full members, members on leave, and former members by
  default in **all member-list endpoints**, including the retained chapter API.
  Current Members use their current ChapterOrg; former Members use their last
  ChapterOrg, resolved consistently with Vanguard's former-inclusive association.
  Authorize against that chapter today. A former member's older chapters do not
  grant access; a transferred current member is not returned in their old chapter.
  Missing chapter associations cannot be authorized by this chapter-based query
  and are excluded, not silently assigned to a chapter. Deduplicate member IDs.
- Former members are a required supported case, not an optional later historical
  filter. Remove the existing active-only filter/current-association inner join
  where it prevents former members or members on leave from being returned.
  Unit/district arrays still describe current assignments, not expired ones.
- `user_roles` comes from the Member's login User's `CombinedUserRole` records.
  Include only roles whose associated record resolves to a ChapterOrg (including
  STI through Organization) or whose organization is absent (national). Exclude
  Unit, District, and other non-ChapterOrg organizations; do not promote their
  roles to their parent chapter. Members without a login/roles return `[]`.
- Each role contains `role_slug`; `role_name` formed by replacing `_` with spaces
  and capitalizing each word; `chapter_org_name` from the associated ChapterOrg;
  and `chapter_org_type` copied exactly from `CombinedUserRole.organization_type`,
  without STI normalization. For national/no-org roles, both chapter fields are
  null and the UI displays “National”. An explicit non-ChapterOrg organization is
  not a no-org national role. These are user roles, not leadership-presenter rows.
- Apply field authorization to roles, including roles outside the Member's chapter;
  set `user_roles_restricted: true` when any eligible roles are withheld. Batch-load
  login users, roles, chapters, and mappings to avoid per-member queries.
- Arrays are always present. Unknown additive fields are allowed. No Signal group
  roster, group ID, or unrelated contacts need to be sent to Vanguard for this read.

### Snapshot and pagination semantics

Plan for authorized lists of 4,000–8,000 Members. Start with a default and
server-enforced maximum page size of 1,000, using opaque cursors and stable member-ID
ordering. Desktop requests 1,000 per page and automatically follows cursors until
`next_cursor: null`, normally 4–8 requests at the expected size. A shorter page is
not completion if a next cursor exists. Return an exact snapshot `total_count`
within the authorized selection for progress reporting.

On an initial or changed response, fetch every page into memory before enabling
linking or Proposed Matches. An unchanged 304 validates the retained complete list
without downloading pages. Show
progress such as “Loading members: 3,000 of 8,000”. The dropdown searches the
complete list locally; pagination is a transport detail, not a partial dropdown
or a user-operated Load more flow. Pagination bounds response sizes and retries,
but does not reduce total data fetched or guarantee faster initial loading.

Retry a transiently failed page with the same snapshot and cursor, bounded backoff,
and `Retry-After` where applicable. Append a page only once after validation;
retries must not duplicate entries. Keep partial data unavailable for linking.
Expired/invalid snapshots require discarding partial replacement data and
restarting with a new snapshot; any previous complete roster remains retained but
unavailable for actions until revalidated or replaced; permission failures must not cause an endless automatic retry loop.

Measure response sizes, end-to-end load time, memory, and provider query cost with
4,000 and 8,000 representative records including roles before rollout. Tune page
size and snapshot TTL from those measurements; never truncate the full list. The
retained per-ChapterOrg endpoint keeps its existing pagination/response behavior.

An unconditional initial request or a conditional request whose roster has changed
creates a short-lived snapshot bound to user, OAuth
application, authorized chapter set, and effective date. Subsequent member pages and the
mapping dictionary reference the same `snapshot_id`. A timestamp alone is not a
consistency guarantee.

Implementation recommendation for chunk 3: materialize the authorized selected
member projection and mapping values from one consistent database view into an
expiring server-side snapshot. Do not hold a database transaction open between
HTTP requests. Establish a size cap/TTL from measured roster sizes; never silently
truncate a response. A revision-based alternative is acceptable only if it
detects relevant membership, user-role, mapping, and permission changes.

Reauthorize snapshot access on every page; invalidate/reject the snapshot if the
caller loses relevant visibility. Return a specific expired/invalid snapshot
error so Desktop restarts the comparison. Before applying actions, fetch current
state again; the snapshot is review context, not continuing write authorization.

### Whole-roster ETags and mandatory revalidation

Support `ETag` / `If-None-Match` on both the flat and per-chapter member-list GET
endpoints. This is read-side bandwidth optimization, separate from mapping-write
concurrency; it requires no write receipts or mandatory `If-Match` headers.

Desktop retains one complete flat roster and its ETag in memory across group
navigation, scoped to Vanguard issuer, OAuth user/client, and local Signal account.
The roster is independent of the selected Signal group. On **every** drill-down:

1. With no complete retained roster/ETag, request the initial Members URL normally.
2. Otherwise request that same initial URL with `If-None-Match: W/"<roster-tag>"`,
   without a snapshot ID or cursor. This validates the live authorized collection,
   not an old snapshot. Await the server result before enabling linking or proposals.
3. Vanguard authenticates and authorizes against current permissions, computes the
   current whole-roster validator, and returns `304 Not Modified` with its ETag
   and no body if unchanged. Desktop can then use the complete retained roster;
   it need not fetch any pages or recreate an expired pagination snapshot.
4. On change, return `200` with a new ETag and the first page of a fresh consistent
   snapshot. Desktop downloads every remaining page into a separate buffer, with
   progress, and atomically replaces the retained roster/ETag only on completion.

Keep the old complete roster while replacement loads or fails, but do not enable
linking/Proposed Matches from it until a successful revalidation or replacement.
A 304 without a complete matching local roster is unusable: retry unconditionally.
Do not promote partial downloads to the retained cache. Cancel/ignore obsolete
view requests; navigating away may abandon an incomplete replacement but must
not erase the last complete roster. Refresh Signal group membership on each entry
and rebuild comparison/proposals from that group plus the validated roster.

#### Validator scope and pagination contract

The initial response's ETag is a **weak semantic validator for the entire ordered,
authorized Member collection**, including inline mappings, roles, field visibility,
and capabilities. It is not a hash of only page one. Changing a Member on page eight
must change the initial-request validator. The per-chapter endpoint applies the
same rule to its chapter collection. Scope tags to the authorized principal,
endpoint/query representation, and serialization schema; never share one user's
validated data with another. Use `Cache-Control: private, no-cache` so retained
responses require validation and are not reusable by shared caches. Desktop must
keep these sensitive bodies in its explicit memory store, not a disk HTTP cache.

Pagination snapshot IDs, cursors, and retrieval timestamps are transport metadata,
not roster identity. They must not cause a new roster tag merely because a new
snapshot was allocated. Use weak validators because byte-identical response
metadata is not promised. The initial tag and all downloaded pages must derive
from the same consistent data view; never compute the tag before a change and
then serialize the replacement after it. Subsequent pages reference that snapshot
and are downloaded normally. Do not treat a page-specific 304 as validation of the
whole roster, or resume an expired cursor after whole-roster revalidation.

Vanguard must cover every dependency: member fields/status, mappings (including
unlink), current/last chapter assignments and names, eligible CombinedUserRoles,
permission/role-field visibility, insertions/deletions, and date-effective changes.
`MAX(members.updated_at)` alone is insufficient. Always authorize before returning
304; access loss must produce the appropriate denial or changed authorized list,
not validation of formerly visible data.

Start with a deterministic digest of the complete authorized projection from the
consistent read already needed for the list, unless an existing reliable revision
source covers all dependencies more cheaply. Digesting the projection still costs
query/serialization work but avoids sending unchanged bodies and remaining pages.
Benchmark 4,000/8,000-record validation cost, bandwidth, and changed-list loading;
optimize generation without adding broad revision-tracking infrastructure or
weakening correctness. Do not create/store a pagination snapshot on an unchanged
304 solely to validate an already complete roster.

After any attempted Link/Unlink or bulk write, invalidate the retained ETag because
mappings may have changed, including when a response is lost. Live mapping reads
may update the current view, but do not make a locally patched roster eligible for
conditional reuse with its old tag. On the next drill-down, fetch a new complete
roster unless it has already been fully refreshed with a new server tag.

Retain the roster only in process memory. Clear it on OAuth disconnect, identity/
provider/Signal-account changes, data erasure, or process exit. Ordinary group
navigation or group disconnect does not erase this account-level roster. Transient
validation errors retain it but disable actions and show a retry state; authorization
denial clears inaccessible data. Always contact Vanguard on entry; never use a TTL
or offline fallback to skip validation. HTTP semantics reference:
[conditional GET](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2).

### Mapping dictionary

```http
GET /api/v1/signal/mappings?snapshot_id=opaque-snapshot&limit=1000
```

```json
{
  "mappings": {
    "mbr_example": "70a81aac-7237-4bc1-9a72-33d055f455ab",
    "mbr_other": null
  },
  "meta": {
    "snapshot_id": "opaque-snapshot",
    "total_count": 2,
    "next_cursor": null
  }
}
```

This example illustrates the dictionary shape independently of the one-member
roster example. Include null for authorized unmapped members so missing keys are
not confused with unmapped state. A missing key before all pages are received is
unknown. Dictionary pages must cover the same selected members as the snapshot's
member list; arbitrary member-ID requests must not bypass that scope.

Mapping endpoints never expose mappings for members outside the caller's current
authorized visibility. Existing mappings survive departure or transfer, but can
be read or changed only by someone with continuing appropriate access.

### Read, replace, and clear one mapping

`GET .../:member_id/mapping` returns the live state. An authorized Member with no
mapping returns `200` with `aci: null`, not `404`.

```http
PUT /api/v1/signal/members/mbr_example/mapping
Content-Type: application/json

{"aci":"70a81aac-7237-4bc1-9a72-33d055f455ab","source":"manual_assignment"}
```

Successful PUT/DELETE returns `200` with `{ member_id, aci, confirmed_at,
updated_at }`; a cleared/absent mapping returns null for ACI and mapping timestamps.
PUT sets or replaces the Member's ACI; DELETE clears it. Setting the current value
or clearing an already-empty mapping succeeds without a duplicate audit change.

Keep these ordinary mapping writes simple: no idempotency keys, operation-receipt
store, mapping-write ETags, required version headers, or mapping revision fields. Authorize each
request and enforce database uniqueness and ordinary audit attribution. Overlapping
valid writes use last-write-wins behavior; preventing a rare intervening admin edit
is not a requirement for this low-volume workflow. Do not silently move an ACI
from another Member when the reverse uniqueness constraint rejects an assignment.

If a response is lost or times out, Desktop rereads the current mapping and shows
that state. If it matches the intended result, display it as linked/unlinked; if
it differs, show the current state and let the user retry explicitly. Do not build
automatic write replay or durable client operation receipts for manual/bulk linking.
This API provides no atomic transaction with Signal group updates.

### Error contract

Use machine-readable errors for new endpoints, e.g.
`{ "error": { "code": "aci_assignment_conflict", "message": "This Signal account is already linked." } }`.
Do not require changing existing endpoints' error format.

| Status | Meaning                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| `400`  | Malformed parameters, invalid cursor, or unsupported filter.                           |
| `401`  | Missing/expired bearer token or invalid user principal.                                |
| `403`  | Required OAuth scope missing; feature-level access denial without resource disclosure. |
| `404`  | Member/scope does not exist or is not visible to the caller.                           |
| `409`  | ACI assignment conflict or invalidated snapshot (distinct error codes).                |
| `410`  | Expired snapshot; restart the read workflow.                                           |
| `422`  | Invalid ACI or unsupported provenance value.                                           |
| `429`  | Rate limited; honor `Retry-After`.                                                     |
| `5xx`  | Transient/unknown outcome; reread the mapping before a user retries a write.           |

For OAuth middleware failures, retain the provider's standard OAuth error format;
the Desktop adapter must normalize both formats. Redact token, phone, and ACI
values from routine logs; detailed mapping audit access is separately controlled.

## Data ownership and lifecycle

- Vanguard owns member status, names, organization structure, and mappings.
  Desktop treats them as external data, not modifications to Signal profiles.
- Mapping identity is deployment-wide, not scoped to an individual Signal group
  or an admin's login. Different authorized admins see the same mapping.
- Signal remains authoritative for actual membership, invitations, and group
  permissions. Vanguard cannot prove that its OAuth user is a Signal group admin;
  Desktop must check that separately.
- Store tokens using the chunk 2 secure-storage design. Namespace any Desktop
  cache/journal by Vanguard issuer/user and Signal account to prevent cross-account
  reuse. Clear roster caches on logout, disconnect, or account switch.
- Retain the complete Members/mappings list and roster ETag in memory across
  drill-downs, with mandatory server revalidation on every entry. Clear on OAuth
  disconnect, account/provider change, data erasure, or process exit; never persist
  Member data to disk. Ignore late responses from obsolete views/connections.
  Provider pagination snapshots are short-lived download aids, not the retained
  client roster. Later operation journals remain separate from roster storage.
- Do not promise mappings or local group connection flags will sync through
  Signal. Shared mappings are reloaded from Vanguard.
- Retention for mapping audit history and snapshot data is
  a rollout decision; none should become an unbounded identity-history store.

## Implementation work packages within Chunk 1

1. **Finalize product/policy decisions.** Confirm reverse uniqueness, access-role
   grants and reverse-ACI conflicts; the status, leave, and former-member inclusion
   rules are settled above. Confirm
   deployment URL/issuer and authorized Desktop client registration owner.
2. **Publish the API schema.** Add proposed endpoints, reusable member/mapping
   schemas, nullable fields, pagination, scope requirements, and error examples to
   Vanguard's OpenAPI document. Document both flat and per-chapter roster options.
3. **Specify storage and operations.** Design the mapping migration, constraints,
   and audited set/clear operations; no concurrency-token or receipt storage.
   Follow Vanguard's operations pattern and Sorbet conventions when implementing.
4. **Specify shared scope and serialization services.** Define policy tests and
   eager-loaded queries for current/last chapter membership and filtered CombinedUserRoles; settle snapshot
   implementation in chunk 3 before enabling paginated reconciliation.
5. **Define the Desktop adapter boundary.** Expose typed context, flat-member-page,
   mapping-page, live-mapping, replace, and clear methods. Preserve unknown fields
   compatibly, normalize errors, and never treat incomplete data as an empty list.

Chunk 1 is ready for implementation handoff once the contract is accepted and its
policy decisions are settled. Actual authentication belongs in chunk 2; roster
service/UI in chunk 3; mapping persistence/API/UI in chunk 4; Proposed Matches
and selected bulk linking in chunk 5. Contract-first work
here should avoid implementing later chunks prematurely.

## Required contract tests

- Ordinary member, unit leader, district leader, chapter leader, and national/admin
  visibility; explicitly assigned permissions and overlapping scopes.
- Direct district members and unit-derived district membership; transfers,
  end-dated assignments, on-leave members, former members, and missing chapter.
- Every required field, E.164/null phones, ChapterOrg/national roles, Unit/District exclusion, and a constant
  number of database queries as the roster grows.
- Rejection of app-only tokens, missing scopes, revoked roles, hidden nested
  data, and cross-scope mapping IDs. Existing chapter API shape/access stay intact; verify its expanded status eligibility.
- Zero/one mapping; replacement; clearing; invalid ACI/PNI; adopted reverse
  uniqueness rule; actor attribution; no phone-number mutation.
- Set/replace/clear, repeated same-value writes, lost responses followed by a
  current-state read, and explicit user retry; no version-precondition contract.
- Full 4,000/8,000-record loading, progress totals, short pages with next cursors,
  retry without duplicates, and no linking before completion.
- Whole-roster 304 reuse across groups; changes confined to later pages; mapping,
  role, chapter, permission, deletion, and date-effective changes invalidate tags.
- Authorization before 304; no-body-cache fallback; complete replacement only;
  failed revalidation disables actions; cache isolation/clearing and write invalidation.
- Snapshot member/mapping consistency, permission loss between pages, expiration,
  explicit completion, oversized selections, and no silent truncation.

## Open decisions and proposed defaults

| Decision                            | Proposed default; not yet confirmed                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| May an ACI map to multiple members? | No; enforce uniqueness across the Vanguard deployment.                                                                  |
| Member visibility (confirmed)       | Flat list uses ChapterOrg-scoped `member:show`; mapping reads/writes additionally require explicit mapping permissions. |
| Membership statuses (confirmed)     | Include candidates, full members, on-leave members, and former members in all member-list endpoints.                    |
| Former-member chapter (confirmed)   | Use the last ChapterOrg with current authorization; never infer departure from absence.                                 |
| User roles (confirmed)              | ChapterOrg-associated and no-org national roles only; exclude Unit/District roles.                                      |
| Group settings (confirmed)          | Local Signal group-settings persistence; clear flags on OAuth disconnect; no roster selection.                          |
| Member data lifecycle (confirmed)   | Retain complete roster/ETag in memory across groups; revalidate on every entry.                                         |
| Deployment, retention, and scale    | Confirm runtime API/issuer URLs, roster sizes, and approved retention before implementation/rollout.                    |

Confirmed rows record product decisions. Reverse uniqueness and deployment/retention
choices remain proposed defaults until settled.

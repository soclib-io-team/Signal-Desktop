# Chunk 1: Vanguard provider contract and identity model

Status: proposed contract; product decisions marked below remain open.

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
- Each member includes first name, last name, phone number, current leadership
  positions, chapter organization name, and current district/unit memberships.
- Expose a dictionary relating Vanguard member IDs to Signal ACIs.
- Each member has zero or one ACI. Setting a new ACI replaces the old mapping;
  dropping the mapping leaves the member unmapped.
- Reading or changing mappings does not itself add or remove anyone from Signal.

## Repository findings

Inspected the local `../vanguard` checkout, whose origin is
`git@github.com:soclib-io-team/vanguard.git`, at commit
`95237c62fd5432f39066a3c6a32c5a382f526a83`. The GitHub page could not be fetched by
the web tool. Findings below describe inspected source, not a verified production
deployment. Existing unrelated working-tree changes were not modified.

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

The existing member endpoint **could be enhanced** with chapter names, leadership,
and expanded district/unit objects. It already supplies much of the required data.
However, its recruiter-oriented access rules, chapter-only selection, omission of
members on leave, and unpaginated response make changing its semantics risky for
existing consumers.

Recommendation: introduce `/api/v1/signal/` endpoints with their own explicit
policies, while extracting/reusing member serialization, association loading, and
current-membership queries where appropriate. Keep the existing member endpoint
compatible. Share tested domain logic rather than copying the controller.

If existing roster authorization and eligibility are ultimately chosen unchanged,
an additive expansion of the existing endpoint is a valid smaller alternative.
The new mapping endpoints are necessary under either approach.

## Authorization and visibility contract

Provisional default, pending the user's access-policy decision: leaders and admins
can read reconciliation data and edit mappings only within their managed scope.
Define separate organization-scoped permissions for reconciliation reads and
mapping management; explicitly grant appropriate national/root access to admins.
Do not infer authorization merely from a role label or the presence of an OAuth
scope.

Every request must satisfy all applicable layers:

1. Valid delegated bearer token tied to a current Vanguard user. Reject app-only
   `client_credentials` tokens for this workflow.
2. Required OAuth scopes for the endpoint.
3. Current Vanguard policy permission over each returned or modified member.
4. Requested chapter/district/unit filters, which can narrow access but never
   expand it.

Use one shared policy/query boundary for roster visibility and mapping visibility.
Mapping writes additionally require the manage permission. Handle direct district
membership and membership through a unit consistently; do not assume a generic
existing policy scope covers both correctly without tests.

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
| `lock_version`         | Monotonically increasing revision for optimistic concurrency.                                                                       |
| `source`               | Controlled value such as `manual_assignment` or `confirmed_lookup`; provenance, not proof of identity.                              |
| `confirmed_at`         | Server time of the admin-confirmed assignment.                                                                                      |
| `updated_by_user_id`   | Actor obtained from the bearer token, never trusted from request JSON.                                                              |
| `oauth_application_id` | Calling client identity for audit attribution.                                                                                      |
| timestamps             | Creation/update timestamps under normal Rails conventions.                                                                          |

Keep the row with `aci = null` after clearing a mapping so revisions cannot reset
through a delete/recreate cycle. A member with no row has logical revision 0;
concurrent first writes must serialize on the member record or otherwise use a
transaction and the unique member index safely.

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

All endpoints below are **new proposals**, not existing deployed routes. Responses
are JSON. Examples use illustrative, shortened Vanguard IDs.

### Endpoint inventory

| Method and path                                    | Purpose                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/v1/signal/context`                       | Caller IDs, effective capabilities, and selectable authorized roster scopes. |
| `GET /api/v1/signal/members`                       | Scoped member listing with required expanded data and a snapshot handle.     |
| `GET /api/v1/signal/mappings`                      | Member-ID-to-ACI dictionary for the same scoped snapshot.                    |
| `GET /api/v1/signal/members/:member_id/mapping`    | Current mapping, including an unmapped state, and its concurrency token.     |
| `PUT /api/v1/signal/members/:member_id/mapping`    | Create or replace that member's ACI mapping.                                 |
| `DELETE /api/v1/signal/members/:member_id/mapping` | Clear the mapping without deleting the member or revision history.           |

No Signal group mutation endpoint belongs in Vanguard. No bulk-write, webhook,
global reverse-ACI lookup, or shared group-association endpoint is required for the
first version. They can be added later if a concrete workflow needs them.

### OAuth scopes

Reuse `api:read` and `members:read` for roster reads and introduce narrowly named
`signal_mappings:read` and `signal_mappings:write` scopes for mapping access.
Mapping writes require `api:write` plus `signal_mappings:write`; mapping reads
require `api:read` plus `signal_mappings:read`. Context requires `api:read` and
reports effective capabilities rather than granting them.

Register new scopes in Doorkeeper's optional scopes, authorization-code grant
allowlist, and the Desktop application's scope allowlist. Configure write
controllers intentionally: the existing base controller defaults to `api:read`
and must not accidentally authorize writes on that basis alone.

Request `openid profile` if using OIDC for caller identity; `email` and `phone`
OIDC scopes are not needed just to obtain roster phone numbers. Chunk 2 must
register a non-confidential Desktop client, validate the actual deployment's
discovery/issuer and callback configuration, and test login/refresh/revocation.
No new OAuth server gem is needed for this plan.

### Context and roster selection

`context` should return `user_id`, `member_id`, effective read/write capabilities,
and stable roster descriptors, for example `{ type: "chapter_org", id, name }` or
`{ type: "unit", id, name, chapter_org_id }`. Capabilities are UI hints; enforce
them again server-side. Large descriptor lists may need pagination.

For the initial version, select one chapter, district, unit, or all-visible scope
per comparison. Store the selected filter locally with the Signal account/group
and Vanguard issuer/user. Do not store the Signal group ID or roster in Vanguard
unless shared group associations become an explicit requirement.

### Member listing

Example request:

```http
GET /api/v1/signal/members?scope_type=chapter_org&scope_id=org_example&membership=current&limit=200
Authorization: Bearer <access-token>
```

Example response:

```json
{
  "members": [
    {
      "id": "mbr_example",
      "first_name": "Alex",
      "last_name": "Rivera",
      "phone_number": "+12025550123",
      "status": "full_member",
      "on_leave": false,
      "chapter_org": {
        "id": "org_example",
        "name": "Example Chapter",
        "type": "branch",
        "districts": [{ "id": "dist_example", "name": "North" }],
        "units": [
          {
            "id": "unit_example",
            "name": "Unit A",
            "district_id": "dist_example"
          }
        ]
      },
      "leadership_positions": [
        {
          "assignment_id": "uld_example",
          "role": "unit_lead",
          "position_type": null,
          "organization": {
            "id": "unit_example",
            "type": "unit",
            "name": "Unit A"
          },
          "chapter_org_id": "org_example",
          "leadership_body": null
        }
      ],
      "capabilities": { "manage_signal_mapping": true }
    }
  ],
  "meta": {
    "snapshot_id": "opaque-snapshot",
    "as_of": "2026-09-25T12:00:00Z",
    "visibility": "authorized_subset",
    "filter": {
      "scope_type": "chapter_org",
      "scope_id": "org_example",
      "membership": "current"
    },
    "total_count": 1,
    "next_cursor": null
  }
}
```

Data rules:

- `phone_number` is validated E.164 or null. Serialize from the stored value using
  server-side normalization; do not assume the model's display getter is E.164.
  Missing/invalid phone data must not make a member disappear from the roster.
- Arrays are present even when empty. `chapter_org` may be null for an authorized
  record with no current chapter; never silently discard such a record.
- Nested district/unit lists describe **this member's current memberships**, not
  every district or unit in the chapter. Districts include direct and unit-derived
  membership, with duplicates removed. Preserve parent IDs where needed.
- Leadership includes current committee positions, unit/district leads, and
  chapter/unit/district liaisons. Include machine-readable roles, relevant entity
  IDs/names, and position type where applicable. Include only assignments valid
  on the snapshot's effective date, including leadership-body term boundaries.
- Administrative application roles are not organizational leadership positions.
  Do not use the existing presenter's synthetic Administrator row as domain data.
- Authorize expanded leadership/organizational fields too. If policy hides some
  assignments, expose that the expansion is partial rather than implying there
  are no other positions. Avoid leaking other scopes through nested objects.
- Extra response fields are allowed; Desktop validates required fields and ignores
  unknown additive fields. Do not return unnecessary sensitive profile data.

Provisional eligibility: include current candidates and full members, **including
those on leave**, with an `on_leave` flag. Leave alone must not recommend removal.
Unlike the existing active-roster endpoint, this avoids making a temporary leave
look like a departure. Leave reasons and dates are not required.

Support `membership=former` or `all` only where explicit historical visibility
exists. Former-member authorization needs historical organization associations;
current chapter joins alone will not find them. Do not infer former status from
absence in a current roster. If historical authorization is deferred, keep these
filters unsupported and label missing accounts unresolved in Desktop.

### Snapshot and pagination semantics

Use a default page size of 200 and a server-enforced maximum, with opaque cursors
and stable member-ID ordering. Return totals only within the authorized selection.
The client considers a list complete only after every page succeeds and the last
page returns `next_cursor: null`.

The initial members request creates a short-lived snapshot bound to user, OAuth
application, scope/filter, and effective date. Subsequent member pages and the
mapping dictionary reference the same `snapshot_id`. A timestamp alone is not a
consistency guarantee.

Implementation recommendation for chunk 3: materialize the authorized selected
member projection and mapping versions from one consistent database view into an
expiring server-side snapshot. Do not hold a database transaction open between
HTTP requests. Establish a size cap/TTL from measured roster sizes; never silently
truncate a response. A revision-based alternative is acceptable only if it
detects relevant membership, leadership, mapping, and permission changes.

Reauthorize snapshot access on every page; invalidate/reject the snapshot if the
caller loses relevant visibility. Return a specific expired/invalid snapshot
error so Desktop restarts the comparison. Before applying actions, fetch current
state again; the snapshot is review context, not continuing write authorization.

### Mapping dictionary

```http
GET /api/v1/signal/mappings?snapshot_id=opaque-snapshot&limit=200
```

```json
{
  "mappings": {
    "mbr_example": "70a81aac-7237-4bc1-9a72-33d055f455ab",
    "mbr_other": null
  },
  "versions": {
    "mbr_example": 3,
    "mbr_other": 0
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
roster; arbitrary member-ID requests must not bypass that scope.

Mapping endpoints never expose mappings for members outside the caller's current
authorized visibility. Existing mappings survive departure or transfer, but can
be read or changed only by someone with continuing appropriate access.

### Read, replace, and clear one mapping

`GET .../:member_id/mapping` returns the live state with a strong ETag. An
authorized member with no mapping returns `200`, `aci: null`, and a revision token,
not `404`.

```http
PUT /api/v1/signal/members/mbr_example/mapping
If-Match: "mapping-mbr_example-v3"
Idempotency-Key: <client-generated-operation-uuid>
Content-Type: application/json

{"aci":"70a81aac-7237-4bc1-9a72-33d055f455ab","source":"manual_assignment"}
```

Successful PUT/DELETE returns `200` with `{ member_id, aci, version, confirmed_at,
updated_at }` and a fresh ETag. DELETE uses the same precondition/idempotency
headers and returns `aci: null`. Replacing an existing ACI is a normal PUT; it does
not append an additional association. Sending the current value or clearing an
already-empty mapping with a current precondition is a successful no-op.

Inside a transaction, enforce the current authorization, expected revision,
member uniqueness, and any adopted reverse-ACI uniqueness rule. Increment the
revision on actual changes and write the audit entry atomically.

Persist an idempotency receipt scoped to actor/client and operation key, including
target, request fingerprint, and response. After reauthorization, an exact retry
returns its stored result before checking the now-stale original precondition.
Reusing the key for a different request is a conflict. Bound receipt retention;
after expiry, Desktop must reread and review current state rather than blindly
replaying an old mutation. Do not repeat a successful replacement after a later
admin has changed it again.

An idempotency response describes that operation's historical outcome; refresh
the live mapping before displaying it as current. This API provides no atomic
transaction with Signal group updates.

### Error contract

Use machine-readable errors for new endpoints, e.g.
`{ "error": { "code": "mapping_version_conflict", "message": "Refresh this mapping before retrying." } }`.
Do not require changing existing endpoints' error format.

| Status | Meaning                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------- |
| `400`  | Malformed parameters, invalid cursor, or unsupported filter.                                    |
| `401`  | Missing/expired bearer token or invalid user principal.                                         |
| `403`  | Required OAuth scope missing; feature-level access denial without resource disclosure.          |
| `404`  | Member/scope does not exist or is not visible to the caller.                                    |
| `409`  | ACI assignment conflict, idempotency-key reuse, or invalidated snapshot (distinct error codes). |
| `410`  | Expired snapshot; restart the read workflow.                                                    |
| `412`  | Stale `If-Match`; fetch and review current mapping.                                             |
| `422`  | Invalid ACI or unsupported provenance value.                                                    |
| `428`  | Mapping mutation missing the required precondition.                                             |
| `429`  | Rate limited; honor `Retry-After`.                                                              |
| `5xx`  | Transient/unknown outcome; use idempotency recovery for writes.                                 |

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
- Prefer an in-memory roster for the first version. If later persistence is needed,
  define expiration and use protected local storage. Define minimal journal
  retention for pending operations separately from roster caching.
- Do not promise mappings or local roster/group associations will sync through
  Signal. Shared mappings are reloaded from Vanguard.
- Retention for mapping audit history, snapshot data, and idempotency receipts is
  a rollout decision; none should become an unbounded identity-history store.

## Implementation work packages within Chunk 1

1. **Finalize product/policy decisions.** Confirm reverse uniqueness, access-role
   grants, member statuses, leave treatment, and historical visibility. Confirm
   deployment URL/issuer and authorized Desktop client registration owner.
2. **Publish the API schema.** Add proposed endpoints, reusable member/mapping
   schemas, nullable fields, pagination, scope requirements, and error examples to
   Vanguard's OpenAPI document. Record compatibility with the existing roster API.
3. **Specify storage and operations.** Design the mapping migration, constraints,
   audited operations, concurrency tokens, and bounded idempotency receipt store.
   Follow Vanguard's operations pattern and Sorbet conventions when implementing.
4. **Specify shared scope and serialization services.** Define policy tests and
   eager-loaded queries for current memberships and leadership; settle snapshot
   implementation in chunk 3 before enabling paginated reconciliation.
5. **Define the Desktop adapter boundary.** Expose typed context, roster-page,
   mapping-page, live-mapping, replace, and clear methods. Preserve unknown fields
   compatibly, normalize errors, and never treat incomplete data as an empty list.

Chunk 1 is ready for implementation handoff once the contract is accepted and its
policy decisions are settled. Actual authentication belongs in chunk 2; roster
service/UI in chunk 3; mapping persistence/API/UI in chunk 5. Contract-first work
here should avoid implementing later chunks prematurely.

## Required contract tests

- Ordinary member, unit leader, district leader, chapter leader, and national/admin
  visibility; explicitly assigned permissions and overlapping scopes.
- Direct district members and unit-derived district membership; transfers,
  end-dated assignments, on-leave members, former members, and missing chapter.
- Every required field, E.164/null phones, current leadership terms, and a constant
  number of database queries as the roster grows.
- Rejection of app-only tokens, missing scopes, revoked roles, hidden nested
  data, and cross-scope mapping IDs. Existing recruiter API behavior stays intact.
- Zero/one mapping; replacement; clearing; invalid ACI/PNI; adopted reverse
  uniqueness rule; actor attribution; no phone-number mutation.
- Concurrent first assignment, replacement, and clearing; stale ETags; repeated
  operation keys; lost responses; retry after a subsequent admin update.
- Snapshot member/mapping consistency, permission loss between pages, expiration,
  explicit completion, oversized selections, and no silent truncation.

## Open decisions and proposed defaults

| Decision                                      | Proposed default; not yet confirmed                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| May an ACI map to multiple members?           | No; enforce uniqueness across the Vanguard deployment.                                                                                                     |
| Who can use reconciliation and edit mappings? | Leaders/admins with explicit read/manage grants within their managed scope. Existing ordinary-member roster access remains unchanged for existing clients. |
| Default membership statuses                   | Candidates and full members; former members only through separately authorized historical review.                                                          |
| Members on leave                              | Include and flag them; do not recommend removal merely because of leave.                                                                                   |
| Exact eligible leadership roles               | Resolve from permission grants, not a blanket assumption that every leadership position grants access.                                                     |
| Historic visibility                           | Defer former-member filters if a suitable scoped policy cannot be established for the first release.                                                       |
| Group/roster association sharing              | Local to this Desktop installation initially.                                                                                                              |
| Deployment, retention, and scale              | Confirm runtime API/issuer URLs, roster sizes, and approved retention before implementation/rollout.                                                       |

These defaults allow subsequent design to proceed, but are not user approval of
the unresolved decisions.

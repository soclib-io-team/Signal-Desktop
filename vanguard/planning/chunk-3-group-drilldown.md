# Chunk 3: Signal group drilldown

Implement the remaining chunk 3 workflow: connected group navigation, current
Signal users, fresh complete flat roster reads, and accessible mapping indicators.
Link/Unlink and Proposed Matches remain chunks 4 and 5; the Actions menu explains
that mapping actions are not available yet.

The main process owns a memory-only complete roster and whole-collection ETag.
A new drilldown starts a cancellable validation, checks connection capabilities,
and downloads a separate snapshot buffer with 1,000-record pages. Validate page
metadata, unique member IDs and ACIs, cursor progress, and terminal totals before
publishing. Retry transient pages with bounded backoff; restart expired snapshots.
Errors never publish partial mappings. Navigation cancels the current replacement
but preserves the complete cache. Disconnect, account replacement, and data erasure
clear it. Every entry revalidates; no age-based cache reuse.

A narrow trusted-main-frame IPC accepts only start/read/cancel with a request UUID
and Signal account. It returns sanitized progress/results, never tokens or URLs.
The renderer polls progress while mounted and ignores obsolete replies. Signal
membership and names derive from live Redux conversations, including distinct
pending invitations; PNI values never join to ACI mappings.

All implementation lives in Vanguard folders. The sole upstream edit replaces the
existing ConnectedGroups composition in smart Preferences with a Vanguard-owned
container so navigation and IPC stay outside upstream components. Existing group
flags and OAuth UI remain unchanged. Test pagination, conditional requests,
failures, cancellation, isolation, IPC validation, and status/name rendering.

## Validation

- Vanguard unit/component suite: 67 tests, including an 8,000-record roster,
  conditional validation, partial failure, snapshot restart, cancellation,
  account isolation, authenticated transport, and permission rejection.
- TypeScript, scoped Oxlint, Prettier, and whitespace checks.
- Headless browser preview with production UI components: open a group, inspect
  the Actions menu, return to the list, and disconnect without navigating.
  Visually inspected status indicators and pending-invitation rendering.

Live acceptance still requires a configured Vanguard account and test Signal
group: verify real authorized visibility, re-entry after a remote mapping change,
permission revocation, and disconnect/reconnect against the deployed provider.

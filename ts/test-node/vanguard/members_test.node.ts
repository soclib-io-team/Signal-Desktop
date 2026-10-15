// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { VanguardMembers } from '../../../app/vanguard/members.node.ts';
import type { RosterAccess } from '../../../app/vanguard/members.node.ts';
import { handleMembersRequest } from '../../../app/vanguard/handler.std.ts';
import type {
  MembersState,
  VanguardMember,
} from '../../vanguard/members.std.ts';

/* oxlint-disable no-await-in-loop */
const account = randomUUID();
function member(id = 'member-1'): VanguardMember {
  return {
    id,
    full_name: 'Alex Rivera',
    chapter_org_name: 'Chapter',
    status: 'full_member',
    signal_user_id: null,
    user_roles: [],
    user_roles_restricted: false,
    capabilities: { manage_signal_mapping: false },
  };
}
function page(
  members: Array<VanguardMember>,
  total = members.length,
  next: string | null = null,
  snapshot = 'snapshot'
) {
  return Response.json(
    {
      members,
      meta: {
        snapshot_id: snapshot,
        as_of: '2026-10-14T12:00:00Z',
        total_count: total,
        next_cursor: next,
        visibility: 'authorized_subset',
      },
    },
    { headers: { ETag: 'W/"roster"' } }
  );
}
async function finish(
  service: VanguardMembers,
  id: string
): Promise<MembersState> {
  for (let i = 0; i < 200; i += 1) {
    const state = service.read(id, account);
    if (state.status !== 'loading') return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Roster did not settle');
}
async function load(
  service: VanguardMembers,
  fetch: RosterAccess['fetch'],
  scope = 'scope'
) {
  const id = randomUUID();
  service.start(id, account, async () => ({ scope, fetch }));
  return finish(service, id);
}

describe('Vanguard complete roster loading', () => {
  it('downloads 8,000 members, reports progress, and revalidates the initial URL across groups', async () => {
    const service = new VanguardMembers();
    let calls = 0;
    const id = randomUUID();
    service.start(id, account, async () => ({
      scope: 'scope',
      fetch: async (query, etag) => {
        assert.equal(query.get('limit'), '1000');
        assert.equal(etag, undefined);
        const offset = calls * 1000;
        if (calls > 0) {
          assert.equal(query.get('cursor'), String(offset));
          assert.equal(query.get('snapshot_id'), 'snapshot');
          assert.equal(service.read(id, account).loaded, offset);
          assert.equal(service.read(id, account).members, undefined);
        }
        calls += 1;
        return page(
          Array.from({ length: 1000 }, (_, i) => member(String(offset + i))),
          8000,
          calls < 8 ? String(offset + 1000) : null
        );
      },
    }));
    const result = await finish(service, id);
    assert.equal(result.status, 'ready');
    assert.equal(result.members?.length, 8000);
    assert.equal(result.members?.at(-1)?.id, '7999');
    assert.equal(calls, 8);
    service.cancel(id);
    const unchanged = await load(service, async (query, etag) => {
      assert.equal(query.toString(), 'limit=1000');
      assert.equal(etag, 'W/"roster"');
      return new Response(null, { status: 304 });
    });
    assert.equal(unchanged.members?.length, 8000);
  });

  it('retries an unusable 304 unconditionally and replaces only a complete changed roster', async () => {
    const service = new VanguardMembers();
    let calls = 0;
    const initial = await load(service, async (_query, etag) => {
      assert.equal(etag, undefined);
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 304 })
        : page([member('old')]);
    });
    assert.equal(initial.status, 'ready');
    assert.equal(calls, 2);
    const changed = await load(service, async (_query, etag) => {
      assert.equal(etag, 'W/"roster"');
      return page([member('replacement')]);
    });
    assert.equal(changed.members?.[0]?.id, 'replacement');
    assert.equal(changed.members?.length, 1);
  });

  it('bounds expired snapshot retries and never publishes an invalid replacement', async () => {
    let calls = 0;
    const result = await load(new VanguardMembers(), async () => {
      calls += 1;
      return new Response(null, { status: 409 });
    });
    assert.equal(calls, 2);
    assert.equal(result.status, 'error');
    assert.equal(result.members, undefined);
  });

  it('retains the complete roster after partial failure and never exposes partial mappings', async () => {
    const service = new VanguardMembers();
    await load(service, async () => page([member('old')]));
    let calls = 0;
    const failed = await load(service, async () => {
      calls += 1;
      return calls === 1
        ? page([member('new')], 2, 'next')
        : new Response(null, { status: 403 });
    });
    assert.equal(failed.status, 'error');
    assert.equal(failed.loaded, 1);
    assert.equal(failed.members, undefined);
    const unchanged = await load(service, async (_query, etag) => {
      assert.equal(etag, 'W/"roster"');
      return new Response(null, { status: 304 });
    });
    assert.equal(unchanged.members?.[0]?.id, 'old');
  });

  it('retries the same cursor without duplication and restarts an expired snapshot', async () => {
    const service = new VanguardMembers();
    const queries: Array<string> = [];
    const replies = [
      page([member('a')], 2, 'next'),
      new Response(null, { status: 503, headers: { 'Retry-After': '0' } }),
      new Response(null, { status: 410 }),
      page([member('b')], 2, 'next2', 'fresh'),
      page([member('c')], 2, null, 'fresh'),
    ];
    const state = await load(service, async query => {
      queries.push(query.toString());
      const response = replies.shift();
      assert(response);
      return response;
    });
    assert.equal(state.status, 'ready');
    assert.deepEqual(
      state.members?.map(value => value.id),
      ['b', 'c']
    );
    assert.equal(queries[1], queries[2]);
    assert.equal(queries[3], 'limit=1000');
  });

  it('rejects duplicate identities, totals, inconsistent snapshots and repeated cursors', async () => {
    const aci = randomUUID();
    const scenarios = [
      [page([member('a')], 2)],
      [page([member('a')], 2, 'next'), page([member('a')], 2)],
      [
        page([
          { ...member('a'), signal_user_id: aci },
          { ...member('b'), signal_user_id: aci },
        ]),
      ],
      [page([member('a')], 2, 'next'), page([member('b')], 2, null, 'changed')],
      [page([member('a')], 3, 'next'), page([member('b')], 3, 'next')],
    ];
    for (const replies of scenarios) {
      const state = await load(new VanguardMembers(), async () => {
        const response = replies.shift();
        assert(response);
        return response;
      });
      assert.equal(state.status, 'error');
      assert.equal(state.members, undefined);
    }
  });

  it('distinguishes an authorized empty list from access denial', async () => {
    const service = new VanguardMembers();
    const empty = await load(service, async () => page([]));
    assert.equal(empty.status, 'ready');
    assert.deepEqual(empty.members, []);
    const denied = await load(
      service,
      async () => new Response(null, { status: 403 })
    );
    assert.equal(denied.status, 'error');
    assert.equal(denied.members, undefined);
  });

  it('isolates scopes and clears retained data on disconnect', async () => {
    const service = new VanguardMembers();
    await load(service, async () => page([member()]));
    await load(
      service,
      async (_query, etag) => {
        assert.equal(etag, undefined);
        return page([]);
      },
      'other-user'
    );
    service.clear();
    await load(
      service,
      async (_query, etag) => {
        assert.equal(etag, undefined);
        return page([]);
      },
      'other-user'
    );
  });

  it('ignores cancelled late replies and stale cancel requests', async () => {
    const service = new VanguardMembers();
    let resolve: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>(done => {
      resolve = done;
    });
    const id = randomUUID();
    service.start(id, account, async () => ({
      scope: 'scope',
      fetch: async () => pending,
    }));
    await Promise.resolve();
    service.cancel(id);
    assert.equal(service.read(id, account).status, 'cancelled');
    const current = randomUUID();
    service.start(current, account, async () => ({
      scope: 'scope',
      fetch: async () => page([member('current')]),
    }));
    service.cancel(id);
    resolve(page([member('obsolete')]));
    assert.equal((await finish(service, current)).members?.[0]?.id, 'current');
    assert.equal(service.read(current, randomUUID()).members, undefined);
  });
});

describe('Vanguard roster IPC', () => {
  it('rejects untrusted frames, URLs, malformed accounts and arbitrary actions', async () => {
    const valid = { action: 'start', account, requestId: randomUUID() };
    const act = (): MembersState => {
      throw new Error('Must not run');
    };
    await assert.rejects(handleMembersRequest(false, valid, act));
    for (const request of [
      { ...valid, url: 'https://other.example' },
      { ...valid, account: 'PNI:123' },
      { ...valid, action: 'delete' },
      { ...valid, requestId: '' },
    ]) {
      await assert.rejects(handleMembersRequest(true, request, act));
    }
  });
  it('sanitizes unexpected errors', async () => {
    const result = await handleMembersRequest(
      true,
      { action: 'start', account, requestId: randomUUID() },
      () => {
        throw new Error('Bearer SECRET');
      }
    );
    assert.equal(result.status, 'error');
    assert(!JSON.stringify(result).includes('SECRET'));
  });
});

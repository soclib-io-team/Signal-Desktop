// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { strict as assert } from 'node:assert';
import {
  GroupConnectionsController,
  canConnectGroup,
} from '../../vanguard/groups.std.ts';
import type { GroupConnections } from '../../vanguard/groups.std.ts';
import type { ConnectionState } from '../../vanguard/types.std.ts';

function required<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}

const account = 'signal-account';
const connected: ConnectionState = {
  status: 'connected',
  issuer: 'https://vanguard.example',
  clientId: 'desktop',
  context: {
    user_id: 'user-1',
    member_id: null,
    capabilities: {
      read_members: true,
      read_signal_mappings: true,
      write_signal_mappings: false,
    },
  },
};
const saved: GroupConnections = {
  account,
  issuer: 'https://vanguard.example',
  clientId: 'desktop',
  userId: 'user-1',
  groupIds: ['group-a'],
};
function fixture(initial?: GroupConnections) {
  let value = initial;
  let response = connected;
  let failSave = false;
  const calls: Array<string> = [];
  const storage = {
    load: () => value,
    save: async (next: GroupConnections | undefined) => {
      if (failSave) {
        throw new Error('SQL unavailable');
      }
      value = next;
    },
  };
  const controller = new GroupConnectionsController(storage, async action => {
    calls.push(action);
    return action === 'disconnect' || action === 'cancel'
      ? { status: 'disconnected' }
      : response;
  });
  return {
    controller,
    storage,
    calls,
    get value() {
      return value;
    },
    set response(next: ConnectionState) {
      response = next;
    },
    set failSave(next: boolean) {
      failSave = next;
    },
  };
}

describe('Vanguard connected groups', () => {
  it('persists selections and restores them after restart without provider roster calls', async () => {
    const f = fixture();
    await f.controller.request('status', account);
    await f.controller.setConnected('group-a', true, () => true);
    await f.controller.setConnected('group-b', true, () => true);
    const restarted = fixture(f.value);
    await restarted.controller.request('status', account);
    assert.deepEqual(restarted.controller.getSnapshot().groupIds, [
      'group-a',
      'group-b',
    ]);
    await restarted.controller.setConnected('group-a', false, () => true);
    assert.deepEqual(restarted.value?.groupIds, ['group-b']);
    assert.deepEqual(f.calls, ['status']);
  });

  it('clears all selections before OAuth disconnect, even if revocation fails', async () => {
    const f = fixture(saved);
    const controller = new GroupConnectionsController(
      f.storage,
      async action => {
        if (action === 'disconnect') {
          assert.equal(f.value, undefined);
          return {
            status: 'disconnected',
            message: 'Remote revocation failed',
          };
        }
        return connected;
      }
    );
    await controller.request('status', account);
    await controller.request('disconnect', account);
    assert.deepEqual(controller.getSnapshot().groupIds, []);
    assert.equal(f.value, undefined);
  });

  it('preserves selections across outages and reconnects to the same Vanguard user', async () => {
    const f = fixture(saved);
    await f.controller.request('status', account);
    f.response = {
      status: 'error',
      issuer: connected.issuer,
      clientId: connected.clientId,
    };
    await f.controller.request('status', account);
    assert.deepEqual(f.value?.groupIds, ['group-a']);
    assert.deepEqual(f.controller.getSnapshot().groupIds, []);
    f.response = connected;
    await f.controller.request('connect', account);
    assert.deepEqual(f.controller.getSnapshot().groupIds, ['group-a']);
  });

  it('does not reuse selections across Signal accounts, Vanguard users, providers, or clients', async () => {
    const variants = [
      { account: 'another-signal', response: connected },
      {
        account,
        response: {
          ...connected,
          context: { ...required(connected.context), user_id: 'user-2' },
        },
      },
      {
        account,
        response: { ...connected, issuer: 'https://another.example' },
      },
      { account, response: { ...connected, clientId: 'another-client' } },
    ];
    await Promise.all(
      variants.map(async variant => {
        const f = fixture(saved);
        f.response = variant.response;
        await f.controller.request('status', variant.account);
        assert.deepEqual(f.storage.load()?.groupIds, []);
        assert.deepEqual(f.controller.getSnapshot().groupIds, []);
      })
    );
  });

  it('hides another account snapshot immediately, before a React effect runs', async () => {
    const f = fixture(saved);
    await f.controller.request('status', account);
    assert.deepEqual(
      f.controller.getSnapshotForAccount('new-account').groupIds,
      []
    );
    assert.equal(
      f.controller.getSnapshotForAccount('new-account').connection.status,
      'disconnected'
    );
  });

  it('does not report a failed save as a connected group and allows retry', async () => {
    const f = fixture();
    await f.controller.request('status', account);
    f.failSave = true;
    await f.controller.setConnected('group-a', true, () => true);
    assert.deepEqual(f.controller.getSnapshot().groupIds, []);
    assert.match(required(f.controller.getSnapshot().error), /Unable to save/);
    f.failSave = false;
    await f.controller.setConnected('group-a', true, () => true);
    assert.deepEqual(f.controller.getSnapshot().groupIds, ['group-a']);
    assert.equal(f.controller.getSnapshot().error, undefined);
  });

  it('still clears OAuth when group cleanup fails and exposes the failure', async () => {
    const f = fixture(saved);
    await f.controller.request('status', account);
    f.failSave = true;
    await f.controller.request('disconnect', account);
    assert(f.calls.includes('disconnect'));
    assert.equal(f.controller.getSnapshot().connection.status, 'error');
    f.failSave = false;
    await f.controller.request('disconnect', account);
    assert.equal(f.value, undefined);
  });

  it('rechecks permission when saving and does not connect while OAuth is unavailable', async () => {
    const f = fixture();
    await f.controller.setConnected('group-a', true, () => true);
    assert.equal(f.value, undefined);
    await f.controller.request('status', account);
    await f.controller.setConnected('group-a', true, () => false);
    assert.deepEqual(f.storage.load()?.groupIds, []);
    assert(f.controller.getSnapshot().error);
  });

  it('ignores a late connection result after disconnect', async () => {
    const f = fixture(saved);
    let finish: (value: ConnectionState) => void = () => {
      throw new Error('not started');
    };
    let started: () => void = () => undefined;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    const controller = new GroupConnectionsController(f.storage, action => {
      if (action === 'disconnect') {
        return Promise.resolve({ status: 'disconnected' });
      }
      return new Promise(resolve => {
        finish = resolve;
        started();
      });
    });
    const pending = controller.request('status', account);
    await ready;
    await controller.request('disconnect', account);
    finish(connected);
    await pending;
    assert.equal(f.value, undefined);
    assert.equal(controller.getSnapshot().connection.status, 'disconnected');
  });

  it('requires a current admin in an accepted, active v2 group to connect', () => {
    const group = {
      id: 'group',
      title: 'Group',
      type: 'group',
      groupVersion: 2,
      areWeAdmin: true,
      acceptedMessageRequest: true,
    };
    assert(canConnectGroup(group));
    for (const override of [
      { type: 'direct' },
      { groupVersion: 1 },
      { areWeAdmin: false },
      { left: true },
      { terminated: true },
      { isBlocked: true },
      { acceptedMessageRequest: false },
    ]) {
      assert.equal(canConnectGroup({ ...group, ...override }), false);
    }
  });
});

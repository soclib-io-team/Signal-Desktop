// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { strict as assert } from 'node:assert';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectedGroups } from '../../vanguard/ConnectedGroups.dom.tsx';
import { ConnectionSettingsView } from '../../vanguard/ConnectionSettings.dom.tsx';
import { handleConnectionRequest } from '../../../app/vanguard/handler.std.ts';
import type { ConnectionState } from '../../vanguard/types.std.ts';

const account = '70a81aac-7237-4bc1-9a72-33d055f455ab';
function render(state: ConnectionState, busy = false) {
  return renderToStaticMarkup(
    <ConnectionSettingsView
      state={state}
      busy={busy}
      onAction={() => undefined}
    />
  );
}

describe('Vanguard connection settings', () => {
  it('explains setup for unconfigured integrations and disclosure before connecting', () => {
    assert.match(
      render({ status: 'unconfigured' }),
      /Vanguard is not configured/
    );
    const html = render({ status: 'disconnected' });
    assert.match(html, /Connect Vanguard/);
    assert.match(html, /Signal account identifiers/);
    assert.match(html, /does not send messages/);
  });
  it('offers cancellation while browser sign-in is pending', () => {
    const html = render({ status: 'connecting' }, true);
    assert.match(html, /Complete sign-in in your browser/);
    assert.match(html, /<button[^>]*type="button">Cancel sign-in<\/button>/);
    assert.match(html, /disabled=""/);
    assert.match(html, /aria-live="polite"/);
  });
  it('shows identity, organization access and a clear read-only restriction', () => {
    const html = render({
      status: 'connected',
      issuer: 'https://vanguard.example',
      context: {
        user_id: 'user-1',
        member_id: 'member-1',
        capabilities: {
          read_members: true,
          read_signal_mappings: false,
          write_signal_mappings: false,
        },
      },
    });
    assert.match(html, /Vanguard user: user-1/);
    assert.match(html, /Member: member-1/);
    assert.match(html, /Read-only: mapping changes are not permitted/);
    assert.match(html, /Mapping reads: not permitted/);
    assert.match(html, /Reconnect Vanguard/);
    assert.match(html, /Disconnect/);
  });
  it('shows provider failures without suggesting successful empty organization access', () => {
    const html = render({ status: 'error', message: 'Provider unavailable' });
    assert.match(html, /Provider unavailable/);
    assert.doesNotMatch(html, /Vanguard user:/);
    assert.match(html, /Refresh connection/);
  });
});

describe('Vanguard IPC boundary', () => {
  it('rejects untrusted senders and arbitrary methods, URLs or token payloads', async () => {
    let calls = 0;
    const act = async (): Promise<ConnectionState> => {
      calls += 1;
      return { status: 'disconnected' };
    };
    await assert.rejects(
      handleConnectionRequest(false, { action: 'connect', account }, act)
    );
    await Promise.all(
      [
        { action: 'fetch', account },
        { action: 'connect', account, url: 'https://evil.example' },
        { action: 'status', account, accessToken: 'secret' },
        { action: 'connect', account: 'PNI:invalid' },
        null,
      ].map(request =>
        assert.rejects(handleConnectionRequest(true, request, act))
      )
    );
    assert.equal(calls, 0);
  });
  it('passes only a validated action and account to the service', async () => {
    const result = await handleConnectionRequest(
      true,
      { action: 'connect', account },
      async (action, receivedAccount) => {
        assert.equal(action, 'connect');
        assert.equal(receivedAccount, account);
        return { status: 'connecting' };
      }
    );
    assert.equal(result.status, 'connecting');
  });
  it('never forwards underlying errors or token values to the renderer', async () => {
    const state = await handleConnectionRequest(
      true,
      { action: 'status', account },
      async () => {
        throw new Error('access_token=secret-value');
      }
    );
    assert.equal(state.status, 'error');
    assert(!JSON.stringify(state).includes('secret-value'));
  });
});

describe('Vanguard connected group settings', () => {
  const connection: ConnectionState = {
    status: 'connected',
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
  const group = {
    id: 'group-1',
    type: 'group',
    title: 'Organizers',
    membersCount: 12,
  };
  function groupsHtml(
    groupIds: ReadonlyArray<string>,
    status = connection,
    busy = false,
    conversations = [group]
  ) {
    return renderToStaticMarkup(
      <ConnectedGroups
        state={{ connection: status, groupIds, busy }}
        conversations={conversations}
        onDisconnect={() => undefined}
      />
    );
  }

  it('shows the empty state only with an OAuth connection', () => {
    assert.match(groupsHtml([]), /Groups connected to Vanguard/);
    assert.match(groupsHtml([]), /No groups connected yet/);
    assert.equal(groupsHtml(['group-1'], { status: 'disconnected' }), '');
    assert.equal(groupsHtml(['group-1'], { status: 'error' }), '');
  });

  it('uses current Signal names/counts and offers disconnect without a drill-down link', () => {
    const html = groupsHtml(['group-1']);
    assert.match(html, /Organizers/);
    assert.match(html, /12 members/);
    assert.match(html, /Disconnect Organizers from Vanguard/);
    assert.doesNotMatch(html, /<a\b|href=|tabindex=/);
    const updated = groupsHtml(['group-1'], connection, false, [
      { ...group, title: 'Renamed group', membersCount: 1 },
    ]);
    assert.match(updated, /Renamed group/);
    assert.match(updated, /1 member</);
    assert.doesNotMatch(updated, /Organizers/);
  });

  it('disables disconnect during persistence and retains cleanup for unavailable groups', () => {
    assert.match(groupsHtml(['group-1'], connection, true), /disabled=""/);
    const html = groupsHtml(['deleted-group']);
    assert.match(html, /Unavailable group/);
    assert.match(html, /Member count unavailable/);
    assert.match(html, /Disconnect unavailable group from Vanguard/);
  });

  it('does not render unrelated groups and escapes group names', () => {
    assert.doesNotMatch(groupsHtml([]), /Organizers/);
    const html = groupsHtml(['group-1'], connection, false, [
      { ...group, title: '<script>bad</script>' },
    ]);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

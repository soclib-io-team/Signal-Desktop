// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { strict as assert } from 'node:assert';
import {
  GroupDrilldownView,
  getGroupUsers,
} from '../../vanguard/GroupDrilldown.dom.tsx';
import type { MembersState } from '../../vanguard/members.std.ts';
import type { ConversationType } from '../../state/ducks/conversations.preload.ts';
import type { ReactNode } from 'react';
import { AppProvider } from '../../windows/AppProvider.dom.tsx';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import { ConnectedGroups } from '../../vanguard/ConnectedGroups.dom.tsx';
import { ConnectionSettingsView } from '../../vanguard/ConnectionSettings.dom.tsx';
import { handleConnectionRequest } from '../../../app/vanguard/handler.std.ts';
import type { ConnectionState } from '../../vanguard/types.std.ts';

function renderToStaticMarkup(children: ReactNode): string {
  return renderMarkup(<AppProvider>{children}</AppProvider>);
}

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
    assert.match(html, /Cancel sign-in/);
    assert.match(html, /aria-disabled="true"/);
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
  it('keeps technical details collapsed and puts identity before the account actions', () => {
    const state: ConnectionState = {
      status: 'connected',
      context: {
        user_id: 'user-1',
        member_id: 'member-1',
        email: 'john@example.com',
        full_name: 'John Doe',
        capabilities: {
          read_members: true,
          read_signal_mappings: true,
          write_signal_mappings: true,
        },
      },
    };
    assert(state.context);
    const html = render(state);
    assert.match(html, /Connected as John Doe &lt;john@example.com&gt;/);
    assert.match(html, /<details[^>]*>/);
    assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|[ >])/);
    assert(html.indexOf('Connected as') < html.indexOf('Reconnect Vanguard'));
    assert(html.indexOf('Connection details') < html.indexOf('Vanguard user:'));
    assert.match(
      render({ ...state, context: { ...state.context, full_name: null } }),
      /Connected as john@example.com/
    );
    assert.match(
      render({ status: 'disconnected' }),
      /Not connected to Vanguard/
    );
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

  it('uses current Signal names/counts and offers a separate disconnect action', () => {
    const html = groupsHtml(['group-1']);
    assert.match(html, /Organizers/);
    assert.match(html, /12 members/);
    assert.match(html, /Disconnect Organizers from Vanguard/);
    assert.doesNotMatch(html, /<a\b|href=/);
    const updated = groupsHtml(['group-1'], connection, false, [
      { ...group, title: 'Renamed group', membersCount: 1 },
    ]);
    assert.match(updated, /Renamed group/);
    assert.match(updated, /1 member</);
    assert.doesNotMatch(updated, /Organizers/);
  });

  it('disables disconnect during persistence and retains cleanup for unavailable groups', () => {
    assert.match(
      groupsHtml(['group-1'], connection, true),
      /aria-disabled="true"/
    );
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

describe('Vanguard group drilldown', () => {
  const first = '70a81aac-7237-4bc1-9a72-33d055f455ab';
  const former = '80a81aac-7237-4bc1-9a72-33d055f455ab';
  const base = {
    full_name: 'Vanguard name',
    chapter_org_name: 'Chapter',
    user_roles: [],
    user_roles_restricted: false,
    capabilities: { manage_signal_mapping: false },
  };
  const users = [
    { id: first, aci: first, name: 'Nickname', pending: false },
    { id: former, aci: former, name: 'Former', pending: false },
    { id: 'PNI:pending', name: 'Invitee', pending: true },
  ];
  function view(state: MembersState) {
    return renderToStaticMarkup(
      <GroupDrilldownView
        title="Organizers"
        count={2}
        users={users}
        state={state}
        onBack={() => undefined}
        onRetry={() => undefined}
      />
    );
  }
  it('labels all three statuses, current count, pending invitations and actions accessibly', () => {
    const html = view({
      status: 'ready',
      loaded: 2,
      members: [
        { ...base, id: 'a', status: 'candidate', signal_user_id: first },
        { ...base, id: 'b', status: 'former_member', signal_user_id: former },
      ],
    });
    assert.match(html, /aria-label="Mapped Vanguard member"/);
    assert.match(html, /aria-label="Former Vanguard member"/);
    assert.match(html, /aria-label="Unresolved within authorized visibility"/);
    assert.match(html, /Pending invitation/);
    assert.match(html, /Actions for Nickname/);
    assert.match(html, /2 members/);
    assert.match(html, /Back to connected groups/);
  });
  it('never presents failed or partial reads as definitive unresolved mappings', () => {
    for (const status of ['loading', 'error'] as const) {
      const html = view({
        status,
        loaded: 1000,
        total: 8000,
        message: 'Please retry',
      });
      assert.match(html, /Mapping not validated/);
      assert.doesNotMatch(
        html,
        /aria-label="Unresolved within authorized visibility"/
      );
      assert.match(
        html,
        status === 'loading'
          ? /Loading members: 1,000 of 8,000/
          : /Incomplete member list/
      );
    }
    assert.match(view({ status: 'error', loaded: 0 }), /Retry/);
  });
  it('prefers nicknames, falls back to profile names and never treats PNI as ACI', () => {
    const group = {
      memberships: [{ aci: first }],
      pendingMemberships: [{ serviceId: 'PNI:pending' }],
    } as unknown as ConversationType;
    const contacts = [
      {
        serviceId: first,
        nicknameGivenName: 'Nick',
        nicknameFamilyName: 'Name',
        profileName: 'Profile',
      },
      { serviceId: former, pni: 'PNI:pending', profileName: 'Pending Profile' },
    ] as unknown as ReadonlyArray<ConversationType>;
    const actual = getGroupUsers(group, contacts);
    assert.equal(actual[0]?.name, 'Nick Name');
    assert.equal(actual[0]?.aci, first);
    assert.equal(actual[1]?.name, 'Pending Profile');
    assert.equal(actual[1]?.aci, undefined);
  });
  it('makes available group rows navigable separately from disconnect', () => {
    const html = renderToStaticMarkup(
      <ConnectedGroups
        state={{
          connection: { status: 'connected' },
          groupIds: ['group'],
          busy: false,
        }}
        conversations={[
          { id: 'group', type: 'group', title: 'Organizers', membersCount: 2 },
        ]}
        onOpen={() => undefined}
        onDisconnect={() => undefined}
      />
    );
    assert.match(html, /Open Organizers Vanguard members/);
    assert.match(html, /Disconnect Organizers from Vanguard/);
  });
});

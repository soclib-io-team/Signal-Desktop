// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { AxoButton } from '../axo/AxoButton.dom.tsx';
import { AxoDropdownMenu } from '../axo/AxoDropdownMenu.dom.tsx';
import { AxoList } from '../axo/items/AxoList.dom.tsx';
import { AxoItem } from '../axo/items/AxoItem.dom.tsx';
import { tw } from '../axo/tw.dom.tsx';
import { mappingStatus } from './members.std.ts';
import type { MembersAPI, MembersState } from './members.std.ts';
import type { ConversationType } from '../state/ducks/conversations.preload.ts';

export type SignalGroupUser = Readonly<{
  id: string;
  aci?: string;
  name: string;
  pending: boolean;
}>;

export function getGroupUsers(
  group: ConversationType,
  conversations: ReadonlyArray<ConversationType>
): ReadonlyArray<SignalGroupUser> {
  const byServiceId = new Map<string, ConversationType>();
  for (const contact of conversations) {
    if (contact.serviceId) byServiceId.set(contact.serviceId, contact);
    if (contact.pni) byServiceId.set(contact.pni, contact);
  }
  const users = [
    ...(group.memberships ?? []).map(member => ({
      id: member.aci as string,
      pending: false,
    })),
    ...(group.pendingMemberships ?? []).map(member => ({
      id: member.serviceId as string,
      pending: true,
    })),
  ];
  return users
    .map(user => {
      const contact = byServiceId.get(user.id);
      const nickname = [contact?.nicknameGivenName, contact?.nicknameFamilyName]
        .filter(Boolean)
        .join(' ')
        .trim();
      return {
        ...user,
        aci: user.id.startsWith('PNI:') ? undefined : user.id.toLowerCase(),
        name:
          nickname ||
          contact?.profileName ||
          contact?.title ||
          'Unknown Signal user',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function GroupDrilldown({
  account,
  group,
  conversations,
  membersAPI,
  onBack,
}: Readonly<{
  account: string;
  group: ConversationType;
  conversations: ReadonlyArray<ConversationType>;
  membersAPI: MembersAPI;
  onBack: () => void;
}>): JSX.Element {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<MembersState>({
    status: 'loading',
    loaded: 0,
  });
  const allowed = Boolean(group.areWeAdmin && !group.left);
  useEffect(() => {
    if (!allowed) return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(action: 'start' | 'read') {
      try {
        const next = await membersAPI({ action, account, requestId });
        if (!active) return;
        setState(next);
        if (next.status === 'loading')
          timer = setTimeout(() => {
            void poll('read');
          }, 250);
      } catch {
        if (active)
          setState({
            status: 'error',
            loaded: 0,
            message: 'Unable to load Vanguard members. Please retry.',
          });
      }
    }
    void poll('start');
    return () => {
      active = false;
      clearTimeout(timer);
      async function cancel() {
        try {
          await membersAPI({ action: 'cancel', account, requestId });
        } catch {
          /* Obsolete replies are ignored even when IPC is unavailable. */
        }
      }
      void cancel();
    };
  }, [account, allowed, requestId, membersAPI]);
  const users = useMemo(
    () => getGroupUsers(group, conversations),
    [group, conversations]
  );
  return (
    <GroupDrilldownView
      title={group.title}
      count={group.membersCount}
      users={users}
      state={
        allowed
          ? state
          : {
              status: 'error',
              loaded: 0,
              message:
                'Signal group administrator access is required to review this group.',
            }
      }
      onBack={onBack}
      onRetry={
        allowed
          ? () => {
              setState({ status: 'loading', loaded: 0 });
              setRequestId(crypto.randomUUID());
            }
          : undefined
      }
    />
  );
}

export function GroupDrilldownView({
  title,
  count,
  users,
  state,
  onBack,
  onRetry,
}: Readonly<{
  title: string;
  count?: number;
  users: ReadonlyArray<SignalGroupUser>;
  state: MembersState;
  onBack: () => void;
  onRetry?: () => void;
}>): JSX.Element {
  const byAci = new Map(
    state.status === 'ready'
      ? state.members
          ?.filter(member => member.signal_user_id)
          .map(member => [member.signal_user_id, member])
      : []
  );
  const ready = state.status === 'ready';
  let message = state.message;
  if (state.status === 'loading') {
    message =
      state.total === undefined
        ? 'Checking current Vanguard members…'
        : `Loading members: ${state.loaded.toLocaleString()} of ${state.total.toLocaleString()}`;
  } else if (ready) {
    message = `${state.loaded.toLocaleString()} authorized Vanguard members loaded.`;
  } else if (state.status === 'cancelled') {
    message = 'Member loading was cancelled. Retry to validate mappings.';
  } else if (state.loaded > 0) {
    message = `Incomplete member list (${state.loaded.toLocaleString()} loaded). ${message ?? ''}`;
  }
  return (
    <AxoList.Root accessibilityLabel={`${title} Vanguard members`}>
      <AxoList.Header>
        <AxoButton.Root variant="subtle-secondary" size="md" onClick={onBack}>
          Back to connected groups
        </AxoButton.Root>
        <AxoList.Label>{title}</AxoList.Label>
        <AxoList.Description>
          {count === undefined
            ? 'Member count unavailable'
            : `${count} ${count === 1 ? 'member' : 'members'}`}
        </AxoList.Description>
      </AxoList.Header>
      <AxoList.Body>
        <div className={tw('p-3 type-body-small text-secondary')}>
          <p
            role={state.status === 'error' ? 'alert' : 'status'}
            aria-live="polite"
          >
            {message}
          </p>
          {(state.status === 'error' || state.status === 'cancelled') &&
            onRetry && (
              <AxoButton.Root
                variant="subtle-primary"
                size="md"
                onClick={onRetry}
              >
                Retry
              </AxoButton.Root>
            )}
          <p>
            Unresolved means no mapping was found within your authorized
            visibility. It does not mean someone should be removed.
          </p>
          <p>Mapping actions will be available in a later update.</p>
        </div>
        {users.length === 0 ? (
          <p className={tw('p-3 type-body-medium text-secondary')}>
            No current Signal members or pending invitations.
          </p>
        ) : (
          <AxoItem.Group>
            {users.map(user => {
              const member = user.aci ? byAci.get(user.aci) : undefined;
              const status = mappingStatus(member);
              const indicator = indicators[ready ? status : 'unvalidated'];
              const { label } = indicator;
              return (
                <AxoItem.Root key={user.id}>
                  <AxoItem.Leading>
                    <span
                      role="img"
                      aria-label={label}
                      className={tw(
                        'inline-flex size-6 items-center justify-center rounded-full'
                      )}
                      style={{
                        backgroundColor: indicator.color,
                        color: '#ffffff',
                        fontWeight: 700,
                      }}
                    >
                      {indicator.symbol}
                    </span>
                  </AxoItem.Leading>
                  <AxoItem.Content>
                    <AxoItem.Label>{user.name}</AxoItem.Label>
                    <AxoItem.Description>
                      {user.pending ? 'Pending invitation · ' : ''}
                      {label}
                      {member ? ` · ${member.full_name}` : ''}
                    </AxoItem.Description>
                    <AxoItem.Accessory>
                      <AxoDropdownMenu.Root>
                        <AxoDropdownMenu.Trigger>
                          <AxoButton.Root
                            variant="subtle-secondary"
                            size="md"
                            aria-label={`Actions for ${user.name}`}
                          >
                            Actions
                          </AxoButton.Root>
                        </AxoDropdownMenu.Trigger>
                        <AxoDropdownMenu.Content>
                          <AxoDropdownMenu.Item
                            disabled
                            onSelect={() => undefined}
                          >
                            Mapping actions coming later
                          </AxoDropdownMenu.Item>
                        </AxoDropdownMenu.Content>
                      </AxoDropdownMenu.Root>
                    </AxoItem.Accessory>
                  </AxoItem.Content>
                </AxoItem.Root>
              );
            })}
          </AxoItem.Group>
        )}
      </AxoList.Body>
    </AxoList.Root>
  );
}

const indicators = {
  current: { label: 'Mapped Vanguard member', color: '#237b37', symbol: '✓' },
  former: { label: 'Former Vanguard member', color: '#bd2626', symbol: '×' },
  unresolved: {
    label: 'Unresolved within authorized visibility',
    color: '#a85b00',
    symbol: '?',
  },
  unvalidated: {
    label: 'Mapping not validated',
    color: '#666666',
    symbol: '–',
  },
};

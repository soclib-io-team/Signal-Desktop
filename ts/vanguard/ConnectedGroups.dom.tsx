// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { AxoList } from '../axo/items/AxoList.dom.tsx';
import { AxoItem } from '../axo/items/AxoItem.dom.tsx';
import { AxoButton } from '../axo/AxoButton.dom.tsx';
import { tw } from '../axo/tw.dom.tsx';
import type { GroupConnectionState, VanguardGroup } from './groups.std.ts';

export function ConnectedGroups({
  state,
  conversations,
  onDisconnect,
}: Readonly<{
  state: GroupConnectionState;
  conversations: ReadonlyArray<VanguardGroup>;
  onDisconnect: (id: string) => void;
}>): JSX.Element | null {
  if (state.connection.status !== 'connected') {
    return null;
  }
  const byId = new Map(
    conversations
      .filter(group => group.type === 'group')
      .map(group => [group.id, group])
  );
  const groups = state.groupIds.map(id => ({ id, group: byId.get(id) }));
  groups.sort((a, b) =>
    (a.group?.title ?? '').localeCompare(b.group?.title ?? '')
  );
  return (
    <AxoList.Root accessibilityLabel="Groups connected to Vanguard">
      <AxoList.Header>
        <AxoList.Label>Groups connected to Vanguard</AxoList.Label>
      </AxoList.Header>
      <AxoList.Body>
        {state.error && (
          <p role="alert" className={tw('p-3 type-body-small text-secondary')}>
            {state.error}
          </p>
        )}
        {groups.length === 0 ? (
          <p className={tw('p-3 type-body-medium text-secondary')}>
            No groups connected yet. Choose “Connect to Vanguard” from a group’s
            menu to add it here.
          </p>
        ) : (
          <AxoItem.Group>
            {groups.map(({ id, group }) => (
              <AxoItem.Root key={id} disabled={state.busy}>
                <AxoItem.Content>
                  <AxoItem.Label>
                    {group?.title ?? 'Unavailable group'}
                  </AxoItem.Label>
                  <AxoItem.Description>
                    {group?.membersCount === undefined
                      ? 'Member count unavailable'
                      : `${group.membersCount} ${group.membersCount === 1 ? 'member' : 'members'}`}
                  </AxoItem.Description>
                  <AxoItem.Accessory>
                    <AxoButton.Root
                      variant="subtle-secondary"
                      size="md"
                      aria-label={`Disconnect ${group?.title ?? 'unavailable group'} from Vanguard`}
                      disabled={state.busy}
                      onClick={() => onDisconnect(id)}
                    >
                      Disconnect
                    </AxoButton.Root>
                  </AxoItem.Accessory>
                </AxoItem.Content>
              </AxoItem.Root>
            ))}
          </AxoItem.Group>
        )}
      </AxoList.Body>
    </AxoList.Root>
  );
}

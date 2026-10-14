// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
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
    <section
      aria-label="Groups connected to Vanguard"
      className={tw('flex flex-col gap-3 p-4')}
    >
      <h3 className={tw('font-semibold')}>Groups connected to Vanguard</h3>
      {state.error && <p role="alert">{state.error}</p>}
      {groups.length === 0 ? (
        <p>
          No groups connected yet. Choose “Connect to Vanguard” from a group’s
          menu to add it here.
        </p>
      ) : (
        <ul className={tw('flex flex-col gap-3')}>
          {groups.map(({ id, group }) => (
            <li
              key={id}
              className={tw(
                'flex flex-wrap items-center justify-between gap-3 rounded-sm border p-3'
              )}
            >
              <div className={tw('min-w-0 flex-1 wrap-break-word')}>
                <p className={tw('font-semibold')}>
                  {group?.title ?? 'Unavailable group'}
                </p>
                <p>
                  {group?.membersCount === undefined
                    ? 'Member count unavailable'
                    : `${group.membersCount} ${group.membersCount === 1 ? 'member' : 'members'}`}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Disconnect ${group?.title ?? 'unavailable group'} from Vanguard`}
                className={tw(
                  'rounded-sm border px-3 py-2 disabled:opacity-50'
                )}
                disabled={state.busy}
                onClick={() => onDisconnect(id)}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

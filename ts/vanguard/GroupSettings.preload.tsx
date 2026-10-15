// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcRenderer } from 'electron';
import { useState } from 'react';
import type { JSX } from 'react';
import { useSelector } from 'react-redux';
import { getUserACI } from '../state/selectors/user.std.ts';
import type { ConversationType } from '../state/ducks/conversations.preload.ts';
import { ConnectedGroups } from './ConnectedGroups.dom.tsx';
import { GroupDrilldown } from './GroupDrilldown.dom.tsx';
import type { GroupConnectionState } from './groups.std.ts';
import type { MembersAPI } from './members.std.ts';

const membersAPI: MembersAPI = request =>
  ipcRenderer.invoke('vanguard:members', request);

export function GroupSettings(
  props: Readonly<{
    state: GroupConnectionState;
    conversations: ReadonlyArray<ConversationType>;
    onDisconnect: (id: string) => void;
  }>
): JSX.Element | null {
  const account = useSelector(getUserACI) ?? '';
  const scope = JSON.stringify([
    account,
    props.state.connection.issuer,
    props.state.connection.clientId,
    props.state.connection.context?.user_id,
  ]);
  return <ScopedGroupSettings key={scope} {...props} account={account} />;
}

function ScopedGroupSettings({
  state,
  conversations,
  onDisconnect,
  account,
}: Readonly<{
  state: GroupConnectionState;
  conversations: ReadonlyArray<ConversationType>;
  onDisconnect: (id: string) => void;
  account: string;
}>): JSX.Element | null {
  const [selected, setSelected] = useState<string>();
  const group = conversations.find(
    value => value.id === selected && value.type === 'group'
  );
  if (state.connection.status !== 'connected') return null;
  if (group && selected && state.groupIds.includes(selected)) {
    return (
      <GroupDrilldown
        key={`${selected}:${group.areWeAdmin}:${group.left}`}
        account={account}
        group={group}
        conversations={conversations}
        membersAPI={membersAPI}
        onBack={() => setSelected(undefined)}
      />
    );
  }
  return (
    <ConnectedGroups
      state={state}
      conversations={conversations}
      onDisconnect={onDisconnect}
      onOpen={setSelected}
    />
  );
}

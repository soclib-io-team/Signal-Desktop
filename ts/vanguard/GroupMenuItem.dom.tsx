// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from 'react';
import { AxoDropdownMenu } from '../axo/AxoDropdownMenu.dom.tsx';
import { canConnectGroup } from './groups.std.ts';
import type { GroupConnectionState, VanguardGroup } from './groups.std.ts';

export function GroupMenuItem({
  group,
  state,
  onChange,
}: Readonly<{
  group: VanguardGroup;
  state: GroupConnectionState;
  onChange: (id: string, connected: boolean) => void;
}>): JSX.Element | null {
  if (state.connection.status !== 'connected' || !canConnectGroup(group)) {
    return null;
  }
  const connected = state.groupIds.includes(group.id);
  return (
    <AxoDropdownMenu.Item
      symbol="link"
      disabled={state.busy}
      onSelect={() => onChange(group.id, !connected)}
    >
      {connected ? 'Disconnect from Vanguard' : 'Connect to Vanguard'}
    </AxoDropdownMenu.Item>
  );
}

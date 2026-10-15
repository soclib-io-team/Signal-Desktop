// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { getUserACI } from '../state/selectors/user.std.ts';
import { getAllConversations } from '../state/selectors/conversations.dom.ts';
import { useToastActions } from '../state/ducks/toast.preload.ts';
import { ToastType } from '../types/Toast.dom.tsx';
import {
  GroupConnectionsController,
  canConnectGroup,
  groupConnectionsSchema,
} from './groups.std.ts';
import type { ConversationType } from '../state/ducks/conversations.preload.ts';
import type { GroupConnectionState } from './groups.std.ts';
import type { ConnectionAPI } from './types.std.ts';
import type { ConnectionAction } from './types.std.ts';
import {
  onVanguardAccountChange,
  requestConnection,
} from './connection.preload.ts';

const controller = new GroupConnectionsController(
  {
    load: () => {
      const value = itemStorage.get('vanguardGroups');
      return value === undefined
        ? undefined
        : groupConnectionsSchema.parse(value);
    },
    save: async value => {
      const previous = itemStorage.get('vanguardGroups');
      try {
        if (value) {
          await itemStorage.put('vanguardGroups', value);
        } else {
          await itemStorage.remove('vanguardGroups');
        }
      } catch (error) {
        // Storage updates its in-memory cache before SQL. Restore it on failure so
        // a later operation cannot accidentally adopt a write that never persisted.
        if (previous) {
          await itemStorage.put('vanguardGroups', previous);
        } else {
          await itemStorage.remove('vanguardGroups');
        }
        throw error;
      }
    },
  },
  requestConnection
);

onVanguardAccountChange(controller.invalidate);

export function useVanguardGroups(): Readonly<{
  state: GroupConnectionState;
  connection: ConnectionAPI;
  setConnected: (id: string, connected: boolean) => Promise<void>;
  conversations: ReadonlyArray<ConversationType>;
}> {
  const account = useSelector(getUserACI) ?? '';
  const conversations = useSelector(getAllConversations);
  const { showToast } = useToastActions();
  const getSnapshot = useCallback(
    () => controller.getSnapshotForAccount(account),
    [account]
  );
  const state = useSyncExternalStore(controller.subscribe, getSnapshot);
  const connection = useCallback(
    (action: ConnectionAction) => controller.request(action, account),
    [account]
  );
  useEffect(() => {
    if (account) {
      void connection('status');
    }
  }, [account, connection]);

  const setConnected = useCallback(
    async (id: string, connected: boolean) => {
      const saved = await controller.setConnected(id, connected, () => {
        const group = window.ConversationController.get(id)?.format();
        // Disconnect is local cleanup and remains available after losing admin
        // status or leaving/deleting a group. Connecting requires current admin.
        return !connected || Boolean(group && canConnectGroup(group));
      });
      if (saved) {
        showToast({
          toastType: ToastType.VanguardGroupConnection,
          parameters: { connected },
        });
      } else if (controller.getSnapshot().error) {
        showToast({ toastType: ToastType.Error });
      }
    },
    [showToast]
  );

  return { state, connection, setConnected, conversations };
}

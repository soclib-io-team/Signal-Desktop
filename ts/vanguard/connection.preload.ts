// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcRenderer } from 'electron';
import type { ConnectionAction, ConnectionState } from './types.std.ts';

export function requestConnection(
  action: ConnectionAction,
  account: string
): Promise<ConnectionState> {
  return ipcRenderer.invoke('vanguard:connection', { action, account });
}

const accountChangeListeners = new Set<() => void>();

export function onVanguardAccountChange(listener: () => void): () => void {
  accountChangeListeners.add(listener);
  return () => accountChangeListeners.delete(listener);
}

export function clearConnectionForAccountChange(
  previous: unknown,
  next: unknown
): boolean {
  if (previous !== next) {
    // Sent before the SQL mutation on the same IPC connection. No account data
    // is needed to cancel in-flight work and clear the old OAuth session.
    accountChangeListeners.forEach(listener => listener());
    ipcRenderer.send('vanguard:account-change');
    return true;
  }
  return false;
}

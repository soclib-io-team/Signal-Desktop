// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcMain, safeStorage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import config from '../config.main.ts';
import { userConfig } from '../user_config.main.ts';
import { configSchema } from './config.std.ts';
import { createSessionStore } from './storage.node.ts';
import { handleConnectionRequest } from './handler.std.ts';
import { VanguardConnection } from './connection.node.ts';
import type { ConnectionState } from '../../ts/vanguard/types.std.ts';

let connection: VanguardConnection | undefined;

export function clearVanguard(): void {
  if (connection) {
    connection.forget();
  } else if (userConfig.get('vanguardOAuth') != null) {
    userConfig.set('vanguardOAuth', null);
  }
}

export function installVanguard(
  getWindow: () => BrowserWindow | undefined
): void {
  let configurationError = false;
  if (config.has('vanguardOAuth')) {
    try {
      connection = new VanguardConnection(
        configSchema.parse(config.get('vanguardOAuth')),
        createSessionStore(
          userConfig,
          {
            isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
            getSelectedStorageBackend: () =>
              safeStorage.getSelectedStorageBackend(),
            encryptString: value =>
              Buffer.from(safeStorage.encryptString(value)),
            decryptString: value => safeStorage.decryptString(value),
          },
          process.platform
        ),
        url => shell.openExternal(url)
      );
    } catch {
      configurationError = true;
    }
  }
  ipcMain.on('vanguard:account-change', event => {
    const window = getWindow();
    if (
      window &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
    ) {
      clearVanguard();
    }
  });
  ipcMain.handle(
    'vanguard:connection',
    async (event, request): Promise<ConnectionState> => {
      const window = getWindow();
      return handleConnectionRequest(
        Boolean(
          window &&
          event.sender === window.webContents &&
          event.senderFrame === window.webContents.mainFrame
        ),
        request,
        async (action, account) => {
          if (!connection) {
            return configurationError
              ? {
                  status: 'error',
                  message:
                    'Invalid Vanguard deployment configuration. Contact your administrator.',
                }
              : { status: 'unconfigured' };
          }
          return connection.act(action, account);
        }
      );
    }
  );
}

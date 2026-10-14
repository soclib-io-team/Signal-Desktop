// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { ConnectionAction, ConnectionState } from './types.std.ts';

export const groupConnectionsSchema = z.object({
  account: z.string().min(1),
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  userId: z.string().min(1),
  groupIds: z.array(z.string().min(1)),
});
export type GroupConnections = z.infer<typeof groupConnectionsSchema>;
export type GroupConnectionState = Readonly<{
  connection: ConnectionState;
  groupIds: ReadonlyArray<string>;
  busy: boolean;
  error?: string;
}>;

const emptyState: GroupConnectionState = {
  connection: { status: 'disconnected' },
  groupIds: [],
  busy: false,
};

// One local SQL settings item, shared by the group menu and preferences. Writes
// are serialized; UI updates only after persistence succeeds. No provider data
// or Signal group protocol changes are involved.
export class GroupConnectionsController {
  #account?: string;
  #revision = 0;
  readonly #listeners = new Set<() => void>();
  #writes: Promise<unknown> = Promise.resolve();
  #request?: Promise<ConnectionState>;
  #state: GroupConnectionState = {
    connection: { status: 'disconnected' },
    groupIds: [],
    busy: false,
  };

  readonly storage: {
    load: () => GroupConnections | undefined;
    save: (value: GroupConnections | undefined) => Promise<void>;
  };
  readonly connection: (
    action: ConnectionAction,
    account: string
  ) => Promise<ConnectionState>;

  constructor(
    storage: GroupConnectionsController['storage'],
    connection: GroupConnectionsController['connection']
  ) {
    this.storage = storage;
    this.connection = connection;
  }

  getSnapshot = (): GroupConnectionState => this.#state;

  getSnapshotForAccount = (account: string): GroupConnectionState =>
    this.#account === account ? this.#state : emptyState;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #publish(state: GroupConnectionState): void {
    this.#state = state;
    this.#listeners.forEach(listener => listener());
  }

  #write<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#writes;
    const run = async () => {
      try {
        await previous;
      } catch {
        // A failed write must not prevent a subsequent explicit retry.
      }
      return work();
    };
    const result = run();
    this.#writes = result;
    return result;
  }

  // Called before Signal replaces/removes its account identifier. The storage
  // hook then removes the SQL item, after already-started writes on that channel.
  invalidate = (): void => {
    this.#revision += 1;
    this.#account = undefined;
    this.#request = undefined;
    this.#publish({
      connection: { status: 'disconnected' },
      groupIds: [],
      busy: false,
    });
  };

  async request(
    action: ConnectionAction,
    account: string
  ): Promise<ConnectionState> {
    if (this.#account !== account) {
      this.invalidate();
      this.#account = account;
    }
    if (action === 'status' && this.#request) {
      return this.#request;
    }
    this.#revision += 1;
    const revision = this.#revision;
    let connection = this.#state.connection;
    if (action === 'connect') {
      connection = { status: 'connecting', issuer: connection.issuer };
    } else if (action === 'disconnect' || action === 'cancel') {
      connection = { status: 'disconnected', issuer: connection.issuer };
    }
    this.#publish({
      ...this.#state,
      busy: true,
      error: undefined,
      connection,
      groupIds: action === 'disconnect' ? [] : this.#state.groupIds,
    });
    const work = this.#perform(action, account, revision);
    this.#request = work;
    try {
      return await work;
    } finally {
      if (this.#request === work) {
        this.#request = undefined;
      }
    }
  }

  async #perform(
    action: ConnectionAction,
    account: string,
    revision: number
  ): Promise<ConnectionState> {
    let cleanupFailed = false;
    try {
      await this.#write(async () => {
        if (revision !== this.#revision) {
          return;
        }
        const saved = this.storage.load();
        if (action === 'disconnect' || (saved && saved.account !== account)) {
          await this.storage.save(undefined);
        }
      });
    } catch {
      cleanupFailed = true;
    }
    // Still clear credentials/revoke on disconnect if local group cleanup fails.
    let connection: ConnectionState;
    try {
      if (revision !== this.#revision) {
        return this.#state.connection;
      }
      connection = await this.connection(action, account);
      await this.#write(async () => {
        if (revision !== this.#revision) {
          return;
        }
        if (cleanupFailed) {
          throw new Error('Group cleanup failed');
        }
        let saved = this.storage.load();
        if (
          saved &&
          (saved.account !== account ||
            (connection.issuer && saved.issuer !== connection.issuer) ||
            (connection.clientId && saved.clientId !== connection.clientId))
        ) {
          await this.storage.save(undefined);
          saved = undefined;
        }
        if (
          connection.status === 'connected' &&
          connection.context &&
          connection.issuer &&
          connection.clientId
        ) {
          const owner = {
            account,
            issuer: connection.issuer,
            clientId: connection.clientId,
            userId: connection.context.user_id,
          };
          if (!saved || saved.userId !== owner.userId) {
            saved = { ...owner, groupIds: [] };
            await this.storage.save(saved);
          }
        }
        if (revision === this.#revision) {
          this.#publish({
            connection,
            groupIds:
              connection.status === 'connected' ? (saved?.groupIds ?? []) : [],
            busy: false,
          });
        }
      });
    } catch {
      connection = {
        status: 'error',
        message:
          'Unable to update Vanguard settings. Retry to finish saving the connection and group settings.',
      };
      if (revision === this.#revision) {
        this.#publish({
          connection,
          groupIds: [],
          busy: false,
          error: connection.message,
        });
      }
    }
    return revision === this.#revision ? connection : this.#state.connection;
  }

  async setConnected(
    groupId: string,
    connected: boolean,
    allowed: () => boolean
  ): Promise<void> {
    if (this.#state.busy || this.#state.connection.status !== 'connected') {
      return;
    }
    const revision = this.#revision;
    this.#publish({ ...this.#state, busy: true, error: undefined });
    try {
      await this.#write(async () => {
        if (revision !== this.#revision) {
          return;
        }
        if (!allowed()) {
          throw new Error('Group access changed');
        }
        const saved = this.storage.load();
        if (
          !saved ||
          saved.account !== this.#account ||
          saved.userId !== this.#state.connection.context?.user_id
        ) {
          throw new Error('Connection changed');
        }
        const ids = new Set(saved.groupIds);
        if (connected) {
          ids.add(groupId);
        } else {
          ids.delete(groupId);
        }
        const groupIds = [...ids];
        await this.storage.save({ ...saved, groupIds });
        if (revision === this.#revision) {
          this.#publish({ ...this.#state, groupIds, busy: false });
        }
      });
    } catch {
      if (revision === this.#revision) {
        this.#publish({
          ...this.#state,
          busy: false,
          error:
            'Unable to save the group setting. Check group access and try again.',
        });
      }
    }
  }
}

export type VanguardGroup = Readonly<{
  id: string;
  title: string;
  type: string;
  groupVersion?: number;
  areWeAdmin?: boolean;
  left?: boolean;
  terminated?: boolean;
  isBlocked?: boolean;
  acceptedMessageRequest?: boolean;
  membersCount?: number;
}>;

export function canConnectGroup(group: VanguardGroup): boolean {
  return (
    group.type === 'group' &&
    group.groupVersion === 2 &&
    Boolean(group.areWeAdmin) &&
    !group.left &&
    !group.terminated &&
    !group.isBlocked &&
    Boolean(group.acceptedMessageRequest)
  );
}

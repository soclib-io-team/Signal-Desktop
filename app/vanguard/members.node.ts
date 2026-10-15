// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { setTimeout as delay } from 'node:timers/promises';
import { RosterError } from './rosterError.std.ts';
import { memberPageSchema } from '../../ts/vanguard/members.std.ts';
import type {
  MembersState,
  VanguardMember,
} from '../../ts/vanguard/members.std.ts';

const snapshotExpired = new Error('Snapshot expired');

/* oxlint-disable no-await-in-loop */

export type RosterAccess = Readonly<{
  scope: string;
  fetch: (
    query: URLSearchParams,
    etag: string | undefined,
    signal: AbortSignal
  ) => Promise<Response>;
}>;

export class VanguardMembers {
  #cache?: {
    scope: string;
    etag?: string;
    members: ReadonlyArray<VanguardMember>;
  };
  #active?: {
    id: string;
    account: string;
    controller: AbortController;
    state: MembersState;
  };

  clear(): void {
    this.#active?.controller.abort();
    this.#active = undefined;
    this.#cache = undefined;
  }

  cancel(id?: string): void {
    if (this.#active && (!id || this.#active.id === id)) {
      this.#active.controller.abort();
      this.#active = undefined;
    }
  }

  read(id: string, account: string): MembersState {
    return this.#active?.id === id && this.#active.account === account
      ? this.#active.state
      : { status: 'cancelled', loaded: 0 };
  }

  start(
    id: string,
    account: string,
    prepare: () => Promise<RosterAccess>
  ): MembersState {
    this.cancel();
    const active = {
      id,
      account,
      controller: new AbortController(),
      state: { status: 'loading', loaded: 0 } as MembersState,
    };
    this.#active = active;
    const { signal } = active.controller;
    const publish = (state: MembersState) => {
      signal.throwIfAborted();
      active.state = state;
    };
    void (async () => {
      try {
        const access = await prepare();
        signal.throwIfAborted();
        if (this.#cache?.scope !== access.scope) this.#cache = undefined;
        for (let restart = 0; restart < 2; restart += 1) {
          try {
            const result = await this.#load(access, signal, publish);
            signal.throwIfAborted();
            this.#cache = { scope: access.scope, ...result };
            publish({
              status: 'ready',
              loaded: result.members.length,
              total: result.members.length,
              members: result.members,
            });
            return;
          } catch (error) {
            if (error !== snapshotExpired || restart === 1) throw error;
            publish({
              status: 'loading',
              loaded: 0,
              message: 'Roster changed. Restarting…',
            });
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        const message =
          error instanceof RosterError
            ? error.message
            : 'Unable to load a complete Vanguard member list. Retry to validate current mappings.';
        active.state = {
          status: 'error',
          loaded: active.state.loaded,
          total: active.state.total,
          message,
        };
      }
    })();
    return active.state;
  }

  async #load(
    access: RosterAccess,
    signal: AbortSignal,
    publish: (state: MembersState) => void
  ) {
    const members: Array<VanguardMember> = [];
    const ids = new Set<string>();
    const acis = new Set<string>();
    const cursors = new Set<string>();
    let snapshot: string | undefined;
    let asOf: string | undefined;
    let total: number | undefined;
    let cursor: string | undefined;
    let etag: string | undefined;
    let conditional = this.#cache?.etag;
    let retriedUnconditionally = false;
    for (;;) {
      signal.throwIfAborted();
      const query = new URLSearchParams({ limit: '1000' });
      if (snapshot && cursor) {
        query.set('snapshot_id', snapshot);
        query.set('cursor', cursor);
      }
      const response = await this.#fetch(
        access,
        query,
        snapshot ? undefined : conditional,
        signal
      );
      if (response.status === 304) {
        if (!snapshot && conditional && this.#cache) return this.#cache;
        if (!snapshot && !retriedUnconditionally) {
          retriedUnconditionally = true;
          conditional = undefined;
          continue;
        }
        throw new Error('Unexpected 304');
      }
      if (response.status === 409 || response.status === 410)
        throw snapshotExpired;
      if (response.status === 401 || response.status === 403) {
        throw new RosterError(
          'Vanguard member or mapping access is unavailable. Refresh the connection or reconnect, then retry.'
        );
      }
      if (!response.ok) throw new Error('Roster unavailable');
      const page = memberPageSchema.parse(await response.json());
      signal.throwIfAborted();
      if (!snapshot) {
        snapshot = page.meta.snapshot_id;
        asOf = page.meta.as_of;
        total = page.meta.total_count;
        etag = response.headers.get('etag') ?? undefined;
      } else if (
        snapshot !== page.meta.snapshot_id ||
        total !== page.meta.total_count ||
        asOf !== page.meta.as_of
      ) {
        throw new Error('Inconsistent snapshot');
      }
      for (const member of page.members) {
        const aci = member.signal_user_id?.toLowerCase();
        if (ids.has(member.id) || (aci && acis.has(aci)))
          throw new Error('Ambiguous roster');
        ids.add(member.id);
        if (aci) acis.add(aci);
        members.push({ ...member, signal_user_id: aci ?? null });
      }
      if (members.length > page.meta.total_count)
        throw new Error('Invalid total');
      publish({ status: 'loading', loaded: members.length, total });
      if (page.meta.next_cursor == null) {
        if (members.length !== total) throw new Error('Incomplete roster');
        return { members, etag };
      }
      if (!page.members.length || cursors.has(page.meta.next_cursor))
        throw new Error('Non-progressing cursor');
      cursor = page.meta.next_cursor;
      cursors.add(cursor);
    }
  }

  async #fetch(
    access: RosterAccess,
    query: URLSearchParams,
    etag: string | undefined,
    signal: AbortSignal
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await access.fetch(query, etag, signal);
        if (response.status !== 429 && response.status < 500) return response;
      } catch (error) {
        signal.throwIfAborted();
        if (attempt === 2) throw error;
      }
      if (attempt === 2) throw new Error('Roster temporarily unavailable');
      const retryAfter = response?.headers.get('retry-after');
      const seconds = retryAfter ? Number(retryAfter) : NaN;
      let wait = 500 * 2 ** attempt;
      if (retryAfter) {
        wait = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - Date.now();
      }
      // Long provider backoffs require an explicit later retry, not early replay.
      if (wait > 15000)
        throw new RosterError('Vanguard is busy. Try again later.');
      await response?.body?.cancel();
      await delay(Number.isFinite(wait) ? Math.max(0, wait) : 1000, undefined, {
        signal,
      });
    }
  }
}

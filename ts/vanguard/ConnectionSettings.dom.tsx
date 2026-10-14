// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { tw } from '../axo/tw.dom.tsx';
import type {
  ConnectionAPI,
  ConnectionAction,
  ConnectionState,
} from './types.std.ts';

export function ConnectionSettings({
  connection,
  connectionState,
}: Readonly<{
  connection: ConnectionAPI;
  connectionState?: ConnectionState;
}>): JSX.Element | null {
  const [state, setState] = useState<ConnectionState>();
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    revision.current += 1;
    async function load() {
      try {
        const value = await connection('status');
        if (active) {
          setState(value);
        }
      } catch {
        if (active) {
          setState({
            status: 'error',
            message: 'Unable to load the Vanguard connection.',
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
      revision.current += 1;
    };
  }, [connection]);
  async function act(action: ConnectionAction) {
    revision.current += 1;
    const current = revision.current;
    setBusy(true);
    if (action === 'connect') {
      setState({ status: 'connecting', issuer: state?.issuer });
    }
    try {
      const result = await connection(action);
      if (revision.current === current) {
        setState(result);
      }
    } catch {
      if (revision.current === current) {
        setState({
          status: 'error',
          message: 'Unable to update the Vanguard connection.',
        });
      }
    }
    if (revision.current === current) {
      setBusy(false);
    }
  }
  return (
    <ConnectionSettingsView
      state={connectionState ?? state}
      busy={busy}
      onAction={action => {
        void act(action);
      }}
    />
  );
}

export function ConnectionSettingsView({
  state,
  busy,
  onAction,
}: Readonly<{
  state: ConnectionState | undefined;
  busy: boolean;
  onAction: (action: ConnectionAction) => void;
}>): JSX.Element | null {
  if (!state) {
    return null;
  }
  if (state.status === 'unconfigured') {
    return (
      <p className={tw('p-4')}>
        Vanguard is not configured. Follow the Vanguard OAuth setup guide for
        this custom Signal build, then restart Signal.
      </p>
    );
  }
  return (
    <section
      aria-label="Vanguard account"
      className={tw('flex flex-col gap-3 p-4')}
    >
      <h3 className={tw('font-semibold')}>Vanguard organization account</h3>
      <p>
        Connect to review your organization access. Future mapping actions can
        send selected Signal account identifiers (ACIs) to Vanguard. Connecting
        does not send messages, contacts, or Signal keys.
      </p>
      {state.issuer && <p>{state.issuer}</p>}
      <div role="status" aria-live="polite">
        {
          {
            connecting: 'Complete sign-in in your browser…',
            connected: 'Connected',
            disconnected: 'Not connected',
            error: 'Connection needs attention',
          }[state.status]
        }
        {state.message && <p>{state.message}</p>}
      </div>
      {state.context && (
        <>
          <p>Vanguard user: {state.context.user_id}</p>
          {state.context.member_id && <p>Member: {state.context.member_id}</p>}
          <p>
            {state.context.capabilities.write_signal_mappings
              ? 'Mapping write access'
              : 'Read-only: mapping changes are not permitted'}
          </p>
          <p>
            Roster reads:{' '}
            {state.context.capabilities.read_members
              ? 'allowed'
              : 'not permitted'}
            . Mapping reads:{' '}
            {state.context.capabilities.read_signal_mappings
              ? 'allowed'
              : 'not permitted'}
            .
          </p>
        </>
      )}
      <button
        className={tw('rounded-sm border px-3 py-2 disabled:opacity-50')}
        type="button"
        disabled={busy || state.status === 'connecting'}
        onClick={() => {
          onAction('connect');
        }}
      >
        {state.status === 'disconnected'
          ? 'Connect Vanguard'
          : 'Reconnect Vanguard'}
      </button>
      <button
        className={tw('rounded-sm border px-3 py-2 disabled:opacity-50')}
        type="button"
        disabled={busy || state.status === 'connecting'}
        onClick={() => {
          onAction('status');
        }}
      >
        Refresh connection
      </button>
      <button
        className={tw('rounded-sm border px-3 py-2 disabled:opacity-50')}
        type="button"
        disabled={busy && state.status !== 'connecting'}
        onClick={() => {
          onAction(state.status === 'connecting' ? 'cancel' : 'disconnect');
        }}
      >
        {state.status === 'connecting' ? 'Cancel sign-in' : 'Disconnect'}
      </button>
    </section>
  );
}

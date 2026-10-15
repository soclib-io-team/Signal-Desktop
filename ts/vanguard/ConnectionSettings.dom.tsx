// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { AxoList } from '../axo/items/AxoList.dom.tsx';
import { AxoButton } from '../axo/AxoButton.dom.tsx';
import { AxoSymbol } from '../axo/AxoSymbol.dom.tsx';
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
  const connected = state.status === 'connected';
  const connecting = state.status === 'connecting';
  const configured = state.status !== 'unconfigured';
  const email = state.context?.email;
  const fullName = state.context?.full_name?.trim();
  let identity = 'Not connected to Vanguard';
  if (connected) {
    identity = 'Connected to Vanguard';
    if (email) {
      const displayName = fullName ? `${fullName} <${email}>` : email;
      identity = `Connected as ${displayName}`;
    }
  }
  let statusLabel = 'Not connected';
  let statusMessage = '';
  if (connected) statusLabel = 'Connected';
  if (connecting) {
    statusLabel = 'Connecting';
    statusMessage = 'Complete sign-in in your browser…';
  } else if (state.status === 'error') {
    statusMessage = 'Connection needs attention. ';
  }
  return (
    <AxoList.Root accessibilityLabel="Vanguard account">
      <AxoList.Header>
        <AxoList.Label>Vanguard organization account</AxoList.Label>
        <AxoList.Description>
          <span
            role="status"
            aria-live="polite"
            className={tw('wrap-anywhere')}
          >
            {identity}
          </span>
        </AxoList.Description>
      </AxoList.Header>
      <AxoList.Body>
        {configured ? (
          <div className={tw('flex flex-wrap gap-2 p-3')}>
            <AxoButton.Root
              variant="subtle-primary"
              size="md"
              disabled={busy || connecting}
              onClick={() => onAction('connect')}
            >
              {connected ? 'Reconnect Vanguard' : 'Connect Vanguard'}
            </AxoButton.Root>
            <AxoButton.Root
              variant="subtle-secondary"
              size="md"
              disabled={busy || connecting}
              onClick={() => onAction('status')}
            >
              Refresh connection
            </AxoButton.Root>
            {(connected || connecting || state.status === 'error') && (
              <AxoButton.Root
                variant="subtle-destructive"
                size="md"
                disabled={busy && !connecting}
                onClick={() => onAction(connecting ? 'cancel' : 'disconnect')}
              >
                {connecting ? 'Cancel sign-in' : 'Disconnect'}
              </AxoButton.Root>
            )}
          </div>
        ) : (
          <p className={tw('p-3 type-body-medium text-secondary')}>
            Vanguard is not configured. Follow the Vanguard OAuth setup guide
            for this custom Signal build, then restart Signal.
          </p>
        )}
        {(connecting || state.message || state.status === 'error') && (
          <p
            role="status"
            aria-live="polite"
            className={tw('px-3 pb-3 type-body-small text-secondary')}
          >
            {statusMessage}
            {state.message}
          </p>
        )}
        <details className={tw('group/vanguard-details')}>
          <summary
            className={tw(
              'flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl p-3 type-body-medium focus-visible:axo-focus-ring [&::-webkit-details-marker]:hidden'
            )}
          >
            Connection details
            <span
              className={tw(
                'text-secondary group-open/vanguard-details:rotate-180'
              )}
            >
              <AxoSymbol.InlineGlyph symbol="chevron-down" label={null} />
            </span>
          </summary>
          <div
            className={tw(
              'flex flex-col gap-3 px-3 pt-1 pb-3 type-body-small wrap-anywhere text-secondary'
            )}
          >
            <p>
              Connect to review your organization access. Future mapping actions
              can send selected Signal account identifiers (ACIs) to Vanguard.
              Connecting does not send messages, contacts, or Signal keys.
            </p>
            {state.issuer && <p>{state.issuer}</p>}
            <p>{statusLabel}</p>
            {state.context && (
              <>
                <p>Vanguard user: {state.context.user_id}</p>
                {state.context.member_id && (
                  <p>Member: {state.context.member_id}</p>
                )}
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
          </div>
        </details>
      </AxoList.Body>
    </AxoList.Root>
  );
}

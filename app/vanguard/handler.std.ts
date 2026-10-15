// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { membersRequestSchema } from '../../ts/vanguard/members.std.ts';
import type {
  MembersRequest,
  MembersState,
} from '../../ts/vanguard/members.std.ts';
import type {
  ConnectionAction,
  ConnectionState,
} from '../../ts/vanguard/types.std.ts';

const requestSchema = z
  .object({
    action: z.enum(['status', 'connect', 'cancel', 'disconnect']),
    account: z.string().uuid(),
  })
  .strict();

export async function handleConnectionRequest(
  trustedSender: boolean,
  request: unknown,
  act: (action: ConnectionAction, account: string) => Promise<ConnectionState>
): Promise<ConnectionState> {
  if (!trustedSender) {
    throw new Error('Unauthorized Vanguard request');
  }
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) {
    throw new Error('Invalid Vanguard request');
  }
  try {
    return await act(parsed.data.action, parsed.data.account);
  } catch {
    return {
      status: 'error',
      message:
        'Vanguard connection failed. Local secure storage may be unavailable.',
    };
  }
}

export async function handleMembersRequest(
  trustedSender: boolean,
  request: unknown,
  act: (request: MembersRequest) => MembersState
): Promise<MembersState> {
  if (!trustedSender) throw new Error('Unauthorized Vanguard request');
  const parsed = membersRequestSchema.safeParse(request);
  if (!parsed.success) throw new Error('Invalid Vanguard request');
  try {
    return act(parsed.data);
  } catch {
    return {
      status: 'error',
      loaded: 0,
      message: 'Unable to load Vanguard members. Retry or reconnect.',
    };
  }
}

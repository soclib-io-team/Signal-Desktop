// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const contextSchema = z.object({
  user_id: z.string().min(1),
  member_id: z.string().min(1).nullable(),
  capabilities: z.object({
    read_members: z.boolean(),
    read_signal_mappings: z.boolean(),
    write_signal_mappings: z.boolean(),
  }),
});
export type VanguardContext = z.infer<typeof contextSchema>;
export type ConnectionState = Readonly<{
  status:
    | 'unconfigured'
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'error';
  issuer?: string;
  context?: VanguardContext;
  message?: string;
}>;
export type ConnectionAction = 'status' | 'connect' | 'cancel' | 'disconnect';
export type ConnectionAPI = (
  action: ConnectionAction
) => Promise<ConnectionState>;

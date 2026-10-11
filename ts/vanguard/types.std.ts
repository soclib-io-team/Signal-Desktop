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
  rosters: z
    .array(
      z.object({
        type: z.enum(['chapter_org', 'district', 'unit', 'all_visible']),
        id: z.string().min(1),
        name: z.string().min(1),
      })
    )
    .max(10000),
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

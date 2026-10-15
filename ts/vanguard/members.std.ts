// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const memberSchema = z.object({
  id: z.string().min(1),
  full_name: z.string(),
  user_id: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  phone_number: z.string().nullable().optional(),
  on_leave: z.boolean().optional(),
  chapter_org_id: z.string().optional(),
  unit_ids: z.array(z.string()).optional(),
  district_ids: z.array(z.string()).optional(),
  chapter_org_name: z.string().nullable(),
  status: z.string().min(1),
  signal_user_id: z.string().uuid().nullable(),
  user_roles: z.array(
    z.object({
      role_slug: z.string(),
      role_name: z.string(),
      chapter_org_name: z.string().nullable(),
      chapter_org_type: z.string().nullable(),
    })
  ),
  user_roles_restricted: z.boolean(),
  capabilities: z.object({ manage_signal_mapping: z.boolean() }),
});
export type VanguardMember = z.infer<typeof memberSchema>;
export const memberPageSchema = z.object({
  members: z.array(memberSchema).max(1000),
  meta: z.object({
    snapshot_id: z.string().min(1),
    as_of: z.string().min(1),
    visibility: z.literal('authorized_subset'),
    total_count: z.number().int().nonnegative(),
    next_cursor: z.string().min(1).nullable(),
  }),
});
export type MembersState = Readonly<{
  status: 'loading' | 'ready' | 'error' | 'cancelled';
  loaded: number;
  total?: number;
  members?: ReadonlyArray<VanguardMember>;
  message?: string;
}>;
export const membersRequestSchema = z
  .object({
    action: z.enum(['start', 'read', 'cancel']),
    account: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();
export type MembersRequest = z.infer<typeof membersRequestSchema>;
export type MembersAPI = (request: MembersRequest) => Promise<MembersState>;

export function mappingStatus(
  member: VanguardMember | undefined
): 'current' | 'former' | 'unresolved' {
  if (!member) return 'unresolved';
  return member.status === 'former_member' ? 'former' : 'current';
}

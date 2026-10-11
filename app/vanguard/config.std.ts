// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const configSchema = z
  .object({
    issuer: z.string().url(),
    clientId: z.string().min(1).max(1024),
    callbackPort: z.number().int().min(1024).max(65535).default(47839),
    requestWriteAccess: z.boolean().default(false),
  })
  .strict()
  .transform(value => {
    const url = new URL(value.issuer);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error('Vanguard issuer must be an HTTPS origin');
    }
    return { ...value, issuer: url.origin };
  });
export type VanguardConfig = z.infer<typeof configSchema>;

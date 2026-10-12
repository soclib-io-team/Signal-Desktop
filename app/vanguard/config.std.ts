// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

const deploymentSchema = z
  .object({
    issuer: z.string().url(),
    clientId: z.string().min(1).max(1024),
    callbackPort: z.number().int().min(1024).max(65535).default(47839),
    requestWriteAccess: z.boolean().default(false),
  })
  .strict();

export function createConfigSchema(
  isDevelopment = false
): z.ZodType<
  z.output<typeof deploymentSchema> & { allowInsecureRequests: boolean }
> {
  return deploymentSchema.transform(value => {
    const url = new URL(value.issuer);
    const allowInsecureRequests =
      isDevelopment &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !allowInsecureRequests) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error('Vanguard issuer must be an HTTPS origin');
    }
    return { ...value, issuer: url.origin, allowInsecureRequests };
  });
}

export const configSchema = createConfigSchema();
export type VanguardConfig = z.infer<typeof configSchema>;

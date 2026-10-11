// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from 'node:buffer';
import { z } from 'zod';

export const sessionSchema = z.object({
  issuer: z.string(),
  clientId: z.string(),
  account: z.string(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite(),
  scope: z.string(),
});
export type Session = z.infer<typeof sessionSchema>;
export type SessionStore = {
  assertAvailable: () => void;
  load: () => Session | undefined;
  save: (session: Session) => void;
  clear: () => void;
};

export function createSessionStore(
  config: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  },
  secure: {
    isEncryptionAvailable: () => boolean;
    getSelectedStorageBackend: () => string;
    encryptString: (value: string) => Buffer<ArrayBuffer>;
    decryptString: (value: Buffer<ArrayBuffer>) => string;
  },
  platform: string
): SessionStore {
  function requireSecureStorage() {
    if (
      !secure.isEncryptionAvailable() ||
      (platform === 'linux' &&
        secure.getSelectedStorageBackend() === 'basic_text')
    ) {
      throw new Error('Secure storage unavailable');
    }
  }
  return {
    assertAvailable: requireSecureStorage,
    load() {
      const encrypted = config.get('vanguardOAuth');
      if (encrypted == null) {
        return undefined;
      }
      requireSecureStorage();
      if (typeof encrypted !== 'string') {
        throw new Error('Invalid session');
      }
      return sessionSchema.parse(
        JSON.parse(secure.decryptString(Buffer.from(encrypted, 'base64')))
      );
    },
    save(session) {
      requireSecureStorage();
      config.set(
        'vanguardOAuth',
        secure.encryptString(JSON.stringify(session)).toString('base64')
      );
    },
    clear() {
      config.set('vanguardOAuth', null);
    },
  };
}

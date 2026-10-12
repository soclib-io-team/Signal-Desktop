// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { VanguardConnection } from '../../../app/vanguard/connection.node.ts';
import {
  configSchema,
  createConfigSchema,
} from '../../../app/vanguard/config.std.ts';
import { createSessionStore } from '../../../app/vanguard/storage.node.ts';
import type { Session } from '../../../app/vanguard/storage.node.ts';
import { listenForCallback } from '../../../app/vanguard/callback.node.ts';

// Fixtures run sequentially to assert request ordering and avoid shared listeners.
/* oxlint-disable no-await-in-loop */

function required<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}

const account = '70a81aac-7237-4bc1-9a72-33d055f455ab';
const issuer = 'https://vanguard.example';
const scopes = 'api:read members:read signal_mappings:read';
const context = {
  user_id: 'user-1',
  member_id: 'member-1',
  capabilities: {
    read_members: true,
    read_signal_mappings: true,
    write_signal_mappings: true,
  },
  rosters: [{ type: 'unit', id: 'unit-1', name: 'Example unit' }],
};
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  revocation_endpoint: `${issuer}/oauth/revoke`,
  code_challenge_methods_supported: ['S256'],
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
function fixture(saved?: Session) {
  let stored = saved;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let tokenResponse = () =>
    json({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  let contextResponse = () => json(context);
  let metadataResponse = () => json(metadata);
  let browser: (url: string) => Promise<void> = async value => {
    const url = new URL(value);
    const callback = new URL(required(url.searchParams.get('redirect_uri')));
    callback.search = new URLSearchParams({
      code: 'code-secret',
      state: required(url.searchParams.get('state')),
    }).toString();
    await fetch(callback);
  };
  const config = {
    issuer,
    clientId: 'desktop-client',
    callbackPort: 0,
    requestWriteAccess: false,
    allowInsecureRequests: false,
  };
  const store = {
    assertAvailable: () => undefined,
    load: () => stored,
    save: (value: Session) => {
      stored = value;
    },
    clear: () => {
      stored = undefined;
    },
  };
  const fetcher: typeof fetch = async (input, options) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, options });
    if (url.includes('.well-known')) {
      return metadataResponse();
    }
    if (url.endsWith('/oauth/token')) {
      return tokenResponse();
    }
    if (url.endsWith('/context')) {
      return contextResponse();
    }
    return new Response(null, { status: 200 });
  };
  const service = new VanguardConnection(
    config,
    store,
    url => browser(url),
    fetcher,
    () => 100000
  );
  return {
    service,
    store,
    calls,
    config,
    fetcher,
    get stored() {
      return stored;
    },
    set browser(value: typeof browser) {
      browser = value;
    },
    set tokenResponse(value: typeof tokenResponse) {
      tokenResponse = value;
    },
    set contextResponse(value: typeof contextResponse) {
      contextResponse = value;
    },
    set metadataResponse(value: typeof metadataResponse) {
      metadataResponse = value;
    },
  };
}
function session(overrides: Partial<Session> = {}): Session {
  return {
    issuer,
    clientId: 'desktop-client',
    account,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: 200000,
    scope: scopes,
    ...overrides,
  };
}

describe('Vanguard OAuth connection', () => {
  it('connects, refreshes and revokes with a development HTTP loopback issuer', async () => {
    const f = fixture();
    Object.assign(
      f.config,
      createConfigSchema(true).parse({
        issuer: 'http://localhost:5000',
        clientId: 'desktop-client',
      }),
      { callbackPort: 0 }
    );
    f.metadataResponse = () =>
      json({
        ...metadata,
        issuer: f.config.issuer,
        authorization_endpoint: `${f.config.issuer}/oauth/authorize`,
        token_endpoint: `${f.config.issuer}/oauth/token`,
        revocation_endpoint: `${f.config.issuer}/oauth/revoke`,
      });
    assert.equal((await f.service.act('connect', account)).status, 'connected');
    required(f.stored).expiresAt = 0;
    assert.equal((await f.service.act('status', account)).status, 'connected');
    assert.equal(
      f.calls.filter(call => call.url.endsWith('/oauth/token')).length,
      2
    );
    await f.service.act('disconnect', account);
    assert(f.calls.some(call => call.url.endsWith('/oauth/revoke')));
    assert(f.calls.every(call => new URL(call.url).origin === f.config.issuer));
  });

  it('uses system-browser S256 PKCE and exposes only validated account context', async () => {
    const f = fixture();
    let authURL: URL | undefined;
    f.browser = async value => {
      authURL = new URL(value);
      const callback = new URL(
        required(authURL.searchParams.get('redirect_uri'))
      );
      callback.searchParams.set('code', 'code-secret');
      callback.searchParams.set(
        'state',
        required(authURL.searchParams.get('state'))
      );
      await fetch(callback);
    };
    const result = await f.service.act('connect', account);
    assert.equal(result.status, 'connected');
    assert.equal(result.context?.user_id, 'user-1');
    assert.equal(result.context?.capabilities.write_signal_mappings, false);
    const tokenCall = required(
      f.calls.find(call => call.url.endsWith('/token'))
    );
    const body = tokenCall.options?.body as URLSearchParams;
    assert.equal(body.get('client_id'), 'desktop-client');
    assert.equal(body.has('client_secret'), false);
    assert.equal(authURL?.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      createHash('sha256')
        .update(required(body.get('code_verifier')))
        .digest('base64url'),
      authURL?.searchParams.get('code_challenge')
    );
    assert.equal(f.stored?.refreshToken, 'refresh-secret');
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert(f.calls.every(call => call.options?.redirect === 'error'));
  });
  it('restores a session after restart without opening the browser', async () => {
    const f = fixture(session());
    f.browser = async () => {
      assert.fail('must not open browser');
    };
    assert.equal((await f.service.act('status', account)).status, 'connected');
    assert.equal(f.calls.length, 1);
  });
  it('refreshes once for concurrent requests and persists rotated tokens', async () => {
    const f = fixture(session({ expiresAt: 0 }));
    await Promise.all([
      f.service.act('status', account),
      f.service.act('status', account),
    ]);
    assert.equal(f.calls.filter(call => call.url.endsWith('/token')).length, 1);
    assert.equal(f.stored?.refreshToken, 'refresh-secret');
    assert.equal(f.stored?.expiresAt, 3700000);
  });
  it('retains an unrotated refresh token when the provider omits it', async () => {
    const f = fixture(session({ expiresAt: 0 }));
    f.tokenResponse = () =>
      json({
        access_token: 'new-access',
        token_type: 'bearer',
        expires_in: 3600,
      });
    await f.service.act('status', account);
    assert.equal(f.stored?.refreshToken, 'old-refresh');
  });
  it('clears an invalid grant and does not leak provider error text', async () => {
    const f = fixture(session({ expiresAt: 0 }));
    f.tokenResponse = () =>
      json({ error: 'invalid_grant', error_description: 'secret' }, 400);
    const state = await f.service.act('status', account);
    assert.equal(state.status, 'error');
    assert.equal(f.stored, undefined);
    assert(!JSON.stringify(state).includes('secret'));
  });
  it('clears expired sessions without a refresh token and revoked access', async () => {
    for (const old of [
      session({ expiresAt: 0, refreshToken: undefined }),
      session(),
    ]) {
      const f = fixture(old);
      f.contextResponse = () => json({}, 401);
      assert.equal((await f.service.act('status', account)).status, 'error');
      assert.equal(f.stored, undefined);
    }
  });
  it('keeps credentials but removes stale capabilities during outages and forbidden responses', async () => {
    for (const status of [403, 429, 500]) {
      const f = fixture(session());
      await f.service.act('status', account);
      f.contextResponse = () => json({}, status);
      const state = await f.service.act('status', account);
      assert.equal(state.status, 'error');
      assert.equal(state.context, undefined);
      assert(f.stored);
    }
  });
  it('rejects malformed context rather than displaying empty access', async () => {
    const f = fixture(session());
    f.contextResponse = () => json({ user_id: 'user-1' });
    assert.equal((await f.service.act('status', account)).status, 'error');
  });
  it('does not reuse credentials across Signal accounts, clients or issuers', async () => {
    for (const old of [
      session({ account: 'another-account' }),
      session({ issuer: 'https://other.example' }),
      session({ clientId: 'other-client' }),
    ]) {
      const f = fixture(old);
      assert.equal(
        (await f.service.act('status', account)).status,
        'disconnected'
      );
      assert.equal(f.stored, undefined);
      assert.equal(f.calls.length, 0);
    }
  });
  it('revokes refresh and access tokens and clears credentials on disconnect', async () => {
    const f = fixture(session());
    assert.equal(
      (await f.service.act('disconnect', account)).status,
      'disconnected'
    );
    assert.equal(f.stored, undefined);
    assert.equal(
      f.calls.filter(call => call.url.endsWith('/revoke')).length,
      2
    );
  });
  it('still clears local credentials when revocation fails', async () => {
    const f = fixture(session());
    f.metadataResponse = () => json({}, 503);
    const state = await f.service.act('disconnect', account);
    assert.equal(state.status, 'disconnected');
    assert.match(required(state.message), /Remote revocation failed/);
    assert.equal(f.stored, undefined);
  });
  it('rejects discovery issuer mismatch, cross-origin endpoints and missing PKCE', async () => {
    for (const bad of [
      { ...metadata, issuer: 'https://evil.example' },
      { ...metadata, token_endpoint: 'https://evil.example/token' },
      { ...metadata, code_challenge_methods_supported: ['plain'] },
    ]) {
      const f = fixture();
      f.metadataResponse = () => json(bad);
      f.browser = async () => {
        assert.fail('must not open browser');
      };
      assert.equal((await f.service.act('connect', account)).status, 'error');
      assert.equal(f.stored, undefined);
    }
  });
  it('cancels browser sign-in without resurrecting a session', async () => {
    const f = fixture();
    let opened!: () => void;
    const ready = new Promise<void>(resolve => {
      opened = resolve;
    });
    f.browser = async () => {
      opened();
    };
    const login = f.service.act('connect', account);
    await ready;
    await f.service.act('cancel', account);
    assert.equal((await login).status, 'disconnected');
    assert.equal(f.stored, undefined);
  });
  it('allows retry after secure storage becomes available without opening the browser prematurely', async () => {
    const f = fixture();
    f.store.assertAvailable = () => {
      throw new Error('Unavailable');
    };
    assert.equal((await f.service.act('connect', account)).status, 'error');
    assert.equal(f.calls.length, 0);
    f.store.assertAvailable = () => undefined;
    assert.equal((await f.service.act('connect', account)).status, 'connected');
  });
  it('discards a late refresh after disconnect or data erasure', async () => {
    for (const erase of [false, true]) {
      const f = fixture(session({ expiresAt: 0 }));
      let release!: (response: Response) => void;
      let started!: () => void;
      const ready = new Promise<void>(resolve => {
        started = resolve;
      });
      const deferred = new Promise<Response>(resolve => {
        release = resolve;
      });
      const fetcher: typeof fetch = async (input, options) => {
        if (
          (input instanceof Request ? input.url : input.toString()).endsWith(
            '/token'
          )
        ) {
          started();
          return deferred;
        }
        return f.fetcher(input, options);
      };
      const service = new VanguardConnection(
        f.config,
        f.store,
        async () => undefined,
        fetcher,
        () => 100000
      );
      const pending = service.act('status', account);
      await ready;
      if (erase) {
        service.forget();
      } else {
        await service.act('disconnect', account);
      }
      release(
        json({
          access_token: 'late-secret',
          refresh_token: 'late-refresh',
          token_type: 'bearer',
          expires_in: 3600,
        })
      );
      assert.equal((await pending).status, 'disconnected');
      assert.equal(f.stored, undefined);
    }
  });
  it('rejects duplicate authorization codes and browser-launch failure', async () => {
    const f = fixture();
    f.browser = async value => {
      const auth = new URL(value);
      const url = new URL(required(auth.searchParams.get('redirect_uri')));
      url.search = new URLSearchParams({
        code: 'first',
        state: required(auth.searchParams.get('state')),
      }).toString();
      url.searchParams.append('code', 'second');
      await fetch(url);
    };
    assert.equal((await f.service.act('connect', account)).status, 'error');
    assert.equal(f.stored, undefined);
    f.browser = async () => {
      throw new Error('Browser unavailable');
    };
    assert.equal((await f.service.act('connect', account)).status, 'error');
  });
  it('handles browser denial without exchanging a token', async () => {
    const f = fixture();
    f.browser = async value => {
      const auth = new URL(value);
      const url = new URL(required(auth.searchParams.get('redirect_uri')));
      url.search = new URLSearchParams({
        error: 'access_denied',
        state: required(auth.searchParams.get('state')),
      }).toString();
      await fetch(url);
    };
    assert.equal((await f.service.act('connect', account)).status, 'error');
    assert(!f.calls.some(call => call.url.endsWith('/token')));
  });
});

describe('Vanguard callback and destination validation', () => {
  it('allows HTTP only for development loopback issuers', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const input = { issuer: `http://${host}:5000`, clientId: 'client' };
      assert.throws(() => configSchema.parse(input));
      assert.equal(
        createConfigSchema(true).parse(input).allowInsecureRequests,
        true
      );
    }
    for (const value of [
      'http://example.com',
      'http://192.168.1.10',
      'http://localhost.example.com',
      'http://localhost:5000/path',
      'http://user:pass@localhost:5000',
      'http://localhost:5000/?query=1',
      'http://localhost:5000/#fragment',
    ]) {
      assert.throws(() =>
        createConfigSchema(true).parse({ issuer: value, clientId: 'client' })
      );
    }
    assert.equal(
      createConfigSchema(true).parse({ issuer, clientId: 'client' })
        .allowInsecureRequests,
      false
    );
  });

  it('rejects insecure or credential-bearing deployment destinations', () => {
    for (const value of [
      'http://example.com',
      'https://user:password@example.com',
      'https://example.com/path',
      'https://example.com/?query=1',
      'https://example.com/#fragment',
    ]) {
      assert.throws(() =>
        configSchema.parse({ issuer: value, clientId: 'client' })
      );
    }
    assert.equal(
      configSchema.parse({ issuer, clientId: 'client' }).callbackPort,
      47839
    );
  });
  it('ignores wrong state, duplicate state, wrong path and POST callbacks', async () => {
    const controller = new AbortController();
    const callback = await listenForCallback(0, 'expected', controller.signal);
    try {
      for (const query of ['state=wrong', 'state=expected&state=expected']) {
        assert.equal(
          (await fetch(`${callback.redirectUri}?${query}`)).status,
          400
        );
      }
      assert.equal(
        (
          await fetch(`${callback.redirectUri}?state=expected`, {
            method: 'POST',
          })
        ).status,
        400
      );
      assert.equal(
        (
          await fetch(
            callback.redirectUri.replace('/callback', '/wrong') +
              '?state=expected'
          )
        ).status,
        400
      );
      await fetch(`${callback.redirectUri}?state=expected&code=code`);
      assert.equal((await callback.result).searchParams.get('code'), 'code');
    } finally {
      callback.close();
    }
  });
  it('rejects malformed callback URLs and unexpected Host headers without closing the listener', async () => {
    const controller = new AbortController();
    const callback = await listenForCallback(0, 'state', controller.signal);
    try {
      const target = new URL(callback.redirectUri);
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const request = httpRequest(
            { hostname: target.hostname, port: target.port, path: 'http://[' },
            response => {
              response.resume();
              resolve(response.statusCode);
            }
          );
          request.on('error', reject);
          request.end();
        }
      );
      assert.equal(status, 400);
      const hostStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          const request = httpRequest(
            callback.redirectUri + '?state=state',
            { headers: { Host: 'evil.example' } },
            response => {
              response.resume();
              resolve(response.statusCode);
            }
          );
          request.on('error', reject);
          request.end();
        }
      );
      assert.equal(hostStatus, 400);
      await fetch(`${callback.redirectUri}?state=state&code=code`);
      assert.equal((await callback.result).searchParams.get('code'), 'code');
    } finally {
      callback.close();
    }
  });
  it('closes an aborted callback listener', async () => {
    const controller = new AbortController();
    const callback = await listenForCallback(0, 'state', controller.signal);
    controller.abort();
    await assert.rejects(callback.result);
    await assert.rejects(fetch(callback.redirectUri));
  });
});

describe('Vanguard encrypted session store', () => {
  it('persists only ciphertext and can decrypt a session after restart', () => {
    let value: unknown;
    const storage = {
      get: () => value,
      set: (_key: string, next: unknown) => {
        value = next;
      },
    };
    const secure = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'keychain',
      encryptString: (plain: string) =>
        Buffer.from(plain.split('').reverse().join('')),
      decryptString: (encrypted: Buffer<ArrayBuffer>) =>
        encrypted.toString().split('').reverse().join(''),
    };
    const store = createSessionStore(storage, secure, 'darwin');
    store.save(session());
    assert(!String(value).includes('old-access'));
    assert.deepEqual(
      createSessionStore(storage, secure, 'darwin').load(),
      session()
    );
    store.clear();
    assert.equal(store.load(), undefined);
  });
  it('never writes tokens when encryption is unavailable or Linux uses basic_text', () => {
    for (const available of [false, true]) {
      const store = createSessionStore(
        { get: () => null, set: () => assert.fail('no write') },
        {
          isEncryptionAvailable: () => available,
          getSelectedStorageBackend: () => 'basic_text',
          encryptString: () => {
            throw new Error('must not encrypt');
          },
          decryptString: () => '',
        },
        'linux'
      );
      assert.throws(() => store.save(session()), /Secure storage unavailable/);
    }
  });
});

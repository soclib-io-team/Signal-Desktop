// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as oauth from 'oauth4webapi';
import type { VanguardConfig } from './config.std.ts';
import { listenForCallback } from './callback.node.ts';
import type { Session, SessionStore } from './storage.node.ts';
import { contextSchema } from '../../ts/vanguard/types.std.ts';
import type {
  ConnectionAction,
  ConnectionState,
} from '../../ts/vanguard/types.std.ts';

export class VanguardConnection {
  #state: ConnectionState = { status: 'disconnected' };
  #session?: Session;
  #account?: string;
  #controller?: AbortController;
  #busy?: Promise<void>;
  #generation = 0;
  #server?: oauth.AuthorizationServer;

  readonly config: VanguardConfig;
  readonly store: SessionStore;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly fetcher: typeof fetch;
  readonly now: () => number;

  constructor(
    config: VanguardConfig,
    store: SessionStore,
    openBrowser: (url: string) => Promise<void>,
    fetcher: typeof fetch = fetch,
    now: () => number = Date.now
  ) {
    this.config = config;
    this.store = store;
    this.openBrowser = openBrowser;
    this.fetcher = fetcher;
    this.now = now;
  }

  async act(
    action: ConnectionAction,
    account: string
  ): Promise<ConnectionState> {
    if (this.#account !== account) {
      this.#generation += 1;
      this.#controller?.abort();
      this.#busy = undefined;
      this.#account = account;
      this.#session = undefined;
      this.#state = { status: 'disconnected' };
      try {
        const saved = this.store.load();
        if (
          saved &&
          saved.account === account &&
          saved.issuer === this.config.issuer &&
          saved.clientId === this.config.clientId
        ) {
          this.#session = saved;
        } else if (saved) {
          this.store.clear();
        }
      } catch {
        this.#state = {
          status: 'error',
          message:
            'Secure storage is unavailable or the saved connection cannot be decrypted. Disconnect to clear it, then try again.',
        };
      }
    }
    if (action === 'cancel' || action === 'disconnect') {
      const old = this.#session;
      this.#generation += 1;
      const generation = this.#generation;
      this.#controller?.abort();
      this.#busy = undefined;
      this.#session = undefined;
      this.store.clear();
      this.#state = { status: 'disconnected' };
      if (old) {
        try {
          await this.#revoke(old);
        } catch {
          if (generation === this.#generation) {
            this.#state = {
              status: 'disconnected',
              message:
                'Local credentials cleared. Remote revocation failed; revoke this application in Vanguard.',
            };
          }
        }
      }
    } else if (!this.#busy && (action === 'connect' || this.#session)) {
      const generation = this.#generation;
      const controller = new AbortController();
      this.#controller = controller;
      const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
      const run = async () => {
        try {
          if (action === 'connect') {
            this.store.assertAvailable();
            const old = this.#session;
            this.#session = undefined;
            this.store.clear();
            this.#state = { status: 'connecting' };
            if (old) {
              try {
                await this.#revoke(old);
              } catch {
                /* Reconnect can proceed after local cleanup. */
              }
            }
            await this.#login(account, controller.signal, generation);
          }
          await this.#context(controller.signal, generation);
        } catch (error) {
          if (generation !== this.#generation) {
            return;
          }
          const invalid =
            error instanceof oauth.ResponseBodyError &&
            error.error === 'invalid_grant';
          if (invalid) {
            this.#session = undefined;
            this.store.clear();
          }
          this.#state = {
            status: 'error',
            message: invalid
              ? 'Access expired or was revoked. Reconnect your Vanguard account.'
              : 'Connection could not be verified. Check provider availability, permissions and secure storage, then retry or reconnect.',
          };
        } finally {
          clearTimeout(timer);
        }
      };
      const work = run();
      this.#busy = work;
      try {
        await work;
      } finally {
        if (this.#busy === work) {
          this.#busy = undefined;
        }
      }
    }
    return { ...this.#state, issuer: this.config.issuer };
  }

  forget(): void {
    this.#generation += 1;
    this.#controller?.abort();
    this.#busy = undefined;
    this.#session = undefined;
    this.#account = undefined;
    this.store.clear();
    this.#state = { status: 'disconnected' };
  }

  #options(signal: AbortSignal) {
    return {
      signal,
      [oauth.allowInsecureRequests]: this.config.allowInsecureRequests,
      [oauth.customFetch]: (url: string, options: RequestInit) => {
        const target = new URL(url);
        if (
          target.origin !== this.config.issuer ||
          target.username ||
          target.password
        ) {
          throw new Error('Untrusted provider destination');
        }
        return this.fetcher(url, {
          ...options,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        });
      },
    };
  }

  async #metadata(signal: AbortSignal): Promise<oauth.AuthorizationServer> {
    if (this.#server) {
      return this.#server;
    }
    const issuer = new URL(this.config.issuer);
    const response = await oauth.discoveryRequest(
      issuer,
      this.#options(signal)
    );
    const server = await oauth.processDiscoveryResponse(issuer, response);
    for (const endpoint of [
      server.authorization_endpoint,
      server.token_endpoint,
      server.revocation_endpoint,
    ]) {
      if (!endpoint) {
        throw new Error('Missing OAuth endpoint');
      }
      const url = new URL(endpoint);
      if (
        url.origin !== issuer.origin ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      ) {
        throw new Error('Untrusted OAuth endpoint');
      }
    }
    if (!server.code_challenge_methods_supported?.includes('S256')) {
      throw new Error('Provider must support S256 PKCE');
    }
    this.#server = server;
    return server;
  }

  #client(): oauth.Client {
    return { client_id: this.config.clientId };
  }

  async #login(account: string, signal: AbortSignal, generation: number) {
    const server = await this.#metadata(signal);
    const state = oauth.generateRandomState();
    const verifier = oauth.generateRandomCodeVerifier();
    const challenge = await oauth.calculatePKCECodeChallenge(verifier);
    const callback = await listenForCallback(
      this.config.callbackPort,
      state,
      signal
    );
    const scope = [
      'api:read',
      'members:read',
      'signal_mappings:read',
      ...(this.config.requestWriteAccess
        ? ['api:write', 'signal_mappings:write']
        : []),
    ].join(' ');
    try {
      const url = new URL(server.authorization_endpoint ?? '');
      url.search = new URLSearchParams({
        client_id: this.config.clientId,
        redirect_uri: callback.redirectUri,
        response_type: 'code',
        scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      signal.throwIfAborted();
      await this.openBrowser(url.href);
      const params = oauth.validateAuthResponse(
        server,
        this.#client(),
        await callback.result,
        state
      );
      const response = await oauth.authorizationCodeGrantRequest(
        server,
        this.#client(),
        oauth.None(),
        params,
        callback.redirectUri,
        verifier,
        this.#options(signal)
      );
      const tokens = await oauth.processAuthorizationCodeResponse(
        server,
        this.#client(),
        response
      );
      this.#save(tokens, account, scope, generation);
    } finally {
      callback.close();
    }
  }

  #save(
    tokens: oauth.TokenEndpointResponse,
    account: string,
    scope: string,
    generation: number
  ) {
    if (generation !== this.#generation) {
      throw new Error('Cancelled');
    }
    if (
      tokens.token_type !== 'bearer' ||
      !tokens.expires_in ||
      !Number.isFinite(tokens.expires_in)
    ) {
      throw new Error('Provider must return expiring bearer tokens');
    }
    const session: Session = {
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      account,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: this.now() + tokens.expires_in * 1000,
      scope: tokens.scope ?? scope,
    };
    this.store.save(session);
    this.#session = session;
  }

  async #context(signal: AbortSignal, generation: number) {
    let session = this.#session;
    if (!session) {
      return;
    }
    if (session.expiresAt <= this.now() + 60000) {
      if (!session.refreshToken) {
        this.#session = undefined;
        this.store.clear();
        throw new Error('Reconnect required');
      }
      const server = await this.#metadata(signal);
      const response = await oauth.refreshTokenGrantRequest(
        server,
        this.#client(),
        oauth.None(),
        session.refreshToken,
        this.#options(signal)
      );
      const tokens = await oauth.processRefreshTokenResponse(
        server,
        this.#client(),
        response
      );
      // Providers may rotate refresh tokens or omit an unchanged token.
      this.#save(
        {
          ...tokens,
          refresh_token: tokens.refresh_token ?? session.refreshToken,
        },
        session.account,
        session.scope,
        generation
      );
      session = this.#session;
      if (!session) {
        throw new Error('Session cleared');
      }
    }
    const response = await this.#options(signal)[oauth.customFetch](
      `${this.config.issuer}/api/v1/signal/context`,
      {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'application/json',
        },
      }
    );
    if (generation !== this.#generation) {
      return;
    }
    if (response.status === 401) {
      this.#session = undefined;
      this.store.clear();
      throw new Error('Access revoked');
    }
    if (!response.ok) {
      throw new Error('Context unavailable');
    }
    const context = contextSchema.parse(await response.json());
    if (generation !== this.#generation) {
      return;
    }
    const scopes = new Set(session.scope.split(' '));
    context.capabilities.read_members &&=
      scopes.has('api:read') && scopes.has('members:read');
    context.capabilities.read_signal_mappings &&=
      scopes.has('api:read') && scopes.has('signal_mappings:read');
    context.capabilities.write_signal_mappings &&=
      scopes.has('api:write') && scopes.has('signal_mappings:write');
    this.#state = { status: 'connected', context };
  }

  async #revoke(session: Session) {
    const signal = AbortSignal.timeout(15000);
    const server = await this.#metadata(signal);
    await Promise.all(
      Array.from(new Set([session.refreshToken, session.accessToken])).map(
        async token => {
          if (!token) {
            return;
          }
          const response = await oauth.revocationRequest(
            server,
            this.#client(),
            oauth.None(),
            token,
            this.#options(signal)
          );
          await oauth.processRevocationResponse(response);
        }
      )
    );
  }
}

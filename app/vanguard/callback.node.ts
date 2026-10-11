// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer } from 'node:http';

export async function listenForCallback(
  port: number,
  state: string,
  signal: AbortSignal
): Promise<{
  redirectUri: string;
  result: Promise<URL>;
  close: () => void;
}> {
  let resolveResult: (value: URL) => void;
  let rejectResult: (error: Error) => void;
  const result = new Promise<URL>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Cancellation can arrive while the browser is still opening.
  // oxlint-disable-next-line promise/prefer-await-to-then -- attach rejection handling before returning the promise
  void result.catch(() => undefined);
  let redirectUri = '';
  let consumed = false;
  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', redirectUri);
    } catch {
      response.writeHead(400).end('Invalid OAuth callback.');
      return;
    }
    if (
      consumed ||
      request.method !== 'GET' ||
      request.headers.host !== new URL(redirectUri).host ||
      url.origin !== new URL(redirectUri).origin ||
      url.pathname !== '/vanguard/oauth/callback' ||
      url.searchParams.getAll('state').length !== 1 ||
      url.searchParams.get('state') !== state
    ) {
      response.writeHead(400).end('Invalid OAuth callback.');
      return;
    }
    consumed = true;
    response
      .writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'",
      })
      .end('Return to Signal Desktop to check the connection.');
    resolveResult(url);
    server.close();
  });
  const close = () => {
    server.close();
    server.closeAllConnections();
    rejectResult(new Error('Connection cancelled'));
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Callback listener unavailable'));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/vanguard/oauth/callback`;
      resolve();
    });
  });
  signal.addEventListener('abort', close, { once: true });
  server.once('close', () => signal.removeEventListener('abort', close));
  if (signal.aborted) {
    close();
  }
  return { redirectUri, result, close };
}

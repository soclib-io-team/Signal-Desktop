# Vanguard OAuth deployment setup

Configure the Rails provider and the custom Desktop build before enabling
**Settings → Account → Vanguard organization account**. Desktop uses a public
OAuth client; **never ship a client secret in Desktop**. The reconciliation
context endpoint below is a provider prerequisite, not an existing Rails route
added by this Desktop change.

1. **Choose the provider origin and callback.** Use a trusted HTTPS origin, e.g.
   `https://vanguard.example.org`, with no path, query, or credentials. Desktop
   binds only `127.0.0.1:47839` while signing in; register exactly
   `http://127.0.0.1:47839/vanguard/oauth/callback`. If that port conflicts with
   another application, choose another port above 1023 and update both the client
   registration and Desktop configuration. Do not expose this port externally.

2. **Configure Doorkeeper and discovery.** Enable authorization-code grants,
   `force_pkce` for public clients, `use_refresh_token`, and finite access-token
   lifetimes (e.g. `access_token_expires_in 1.hour`). Require S256 PKCE. Publish
   `/.well-known/openid-configuration` using the existing
   `doorkeeper-openid_connect` setup. Its `issuer` must match the configured
   origin; `authorization_endpoint`, `token_endpoint`, and `revocation_endpoint`
   must be HTTPS URLs on that same origin, without queries or fragments.
   Advertise `code_challenge_methods_supported: ["S256"]`. In Vanguard, set
   `OIDC_ISSUER_URL` to the public origin and keep `OIDC_SIGNING_KEY` in the Rails
   deployment's secret manager. Check proxy/HTTPS settings so discovery does not
   advertise internal hosts or HTTP. Allow the exact HTTP loopback redirect if
   your Doorkeeper version's redirect policy requires an exception; retain HTTPS
   enforcement for other redirects. Desktop uses discovery for OAuth metadata;
   it does not request or use ID tokens.

3. **Register scopes and the public client.** Add `signal_mappings:read` and,
   if needed, `signal_mappings:write` to Doorkeeper's `optional_scopes` and
   `scopes_by_grant_type[:authorization_code]`. Keep the existing scopes in those
   lists. Register the Desktop application through the admin UI or Rails console:

   ```ruby
   desktop = Doorkeeper::Application.create!(
     name: "Vanguard Signal Desktop",
     redirect_uri: "http://127.0.0.1:47839/vanguard/oauth/callback",
     confidential: false,
     scopes: "api:read members:read signal_mappings:read"
   )
   puts desktop.uid
   ```

   Copy only the UID/client ID. Any secret Doorkeeper generates is unused by
   this client. For an approved write-enabled deployment, additionally allow
   `api:write signal_mappings:write` on the application. Keep user consent and
   existing login/2FA requirements. Do not grant this client app-only roster
   access. See [Doorkeeper's PKCE guide](https://doorkeeper.gitbook.io/guides/ruby-on-rails/pkce-flow).

4. **Deploy the authenticated context endpoint.** Implement
   `GET /api/v1/signal/context` with a delegated user token and `api:read`.
   Return the caller's effective permissions and only authorized roster scopes;
   enforce current server-side policy independently of OAuth scopes. Desktop
   expects this JSON shape (extra fields are ignored):

   ```json
   {
     "user_id": "usr_example",
     "member_id": "mbr_example",
     "capabilities": {
       "read_members": true,
       "read_signal_mappings": true,
       "write_signal_mappings": false
     },
     "rosters": [
       { "type": "unit", "id": "unit_example", "name": "Example unit" }
     ]
   }
   ```

   `member_id` may be null; roster types are `chapter_org`, `district`, `unit`,
   or `all_visible`. Every descriptor needs a stable nonempty ID and name.
   Return the complete authorized descriptor list, up to 10,000 entries;
   pagination is not supported in this chunk. Return 401 for invalid/revoked
   credentials and 403 for feature-level denial. An authorized user with no
   access can receive false capabilities and an empty roster list. Without this
   endpoint, OAuth tokens can be issued but Desktop cannot verify the connection.

5. **Configure and package Desktop.** Merge the following into the custom build's
   `config/local-production.json` (or `config/local-development.json` for a
   development run), preserving existing keys:

   ```json
   {
     "vanguardOAuth": {
       "issuer": "https://vanguard.example.org",
       "clientId": "PASTE_THE_APPLICATION_UID",
       "callbackPort": 47839,
       "requestWriteAccess": false
     }
   }
   ```

   Use the file matching `SIGNAL_ENV` when packaging; the existing packaging
   configuration includes `config/local-${env.SIGNAL_ENV}.json`. Set
   `requestWriteAccess` to true only with the write scopes from step 3 and
   corresponding provider permissions. No user-editable destination or client
   secret is exposed in Settings. Omit `vanguardOAuth` to hide the integration.

6. **Prepare secure storage and networking.** Ensure the OS credential store is
   available; Linux must use a real secret-store backend, not Electron's
   `basic_text` fallback. Desktop refuses sign-in without secure encryption.
   Tokens are encrypted using Electron `safeStorage` in the user's Signal
   `config.json`; do not copy this file between machines. Permit outbound HTTPS
   to the provider and local browser access to the loopback callback. Redact
   authorization codes, tokens, verifiers, and authorization headers in provider
   and proxy logs. No browser CORS exception is required for main-process API calls.

7. **Run a deployment smoke test.** Connect from Settings, complete login/2FA and
   consent, and check the displayed user, rosters, and read-only/write access.
   Restart Desktop and reopen Settings. Allow the access token to approach expiry
   and use **Refresh connection** to verify refresh and token rotation. Test
   denied consent, **Cancel sign-in**, provider outage, revoked access, reconnect,
   and a second Signal account. **Disconnect** clears local credentials and
   attempts revocation of both refresh and access tokens; if the provider is
   unreachable, revoke the application's grant through Vanguard when available.
   Verify unavailable secure storage prevents login and that data erasure clears
   the connection. Signing out of Vanguard's browser session is a separate action.

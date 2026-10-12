# Connect Signal Desktop to Vanguard

Use this guide to fill out Vanguard's **New Application** form, copy the generated
client ID into the Signal Desktop project, and sign in.

**Before you start:** Vanguard still needs the Signal-specific scopes and
`/api/v1/signal/context` endpoint described in the
[provider requirements](../planning/chunk-2-oauth-connection.md#provider-requirements).
Registering the application alone will not complete the connection until those
server changes are deployed.

## Register the application in Vanguard

1. **Open the New Application form** shown in the screenshot. In **Name**, enter:

   ```text
   Signal Desktop
   ```

2. **In Redirect URI, paste this exact address on one line:**

   ```text
   http://127.0.0.1:47839/vanguard/oauth/callback
   ```

   This address lets your browser return the sign-in result to Signal on your
   computer. Keep `http`, the port `47839`, and the full path exactly as shown.
   It is not your Vanguard website address.

3. **Uncheck Confidential.** It is checked in the screenshot. Signal Desktop is
   a public client: it uses PKCE to protect sign-in and does not use a client
   secret. Leave this box unchecked even if Vanguard later displays a secret.

4. **In Scopes, paste the following, separated by spaces:**

   ```text
   api:read api:write members:read signal_mappings:read signal_mappings:write
   ```

   Signal needs to read existing mappings and write the mappings reviewed by an
   admin back to Vanguard. Mapping writes require both `api:write` and
   `signal_mappings:write`. Do not leave the field blank. If Vanguard rejects
   either mapping scope, ask the Vanguard developer to deploy the scope changes
   linked above before continuing.

5. **Click Submit.** On the application's details page, copy the value labelled
   **Application UID** or **Client ID**. You will paste it into `clientId` below.

   **What about the generated secret?** Do not copy it into Signal, a `.env`
   file, or source control. This integration has no `clientSecret` setting and
   does not use that value. If you left **Confidential** checked, edit the
   application and uncheck it before proceeding.

## Put the client ID in the Signal project

6. **Open the appropriate configuration file in your Signal-Desktop checkout.**
   Paths below are relative to the project root:

   | How you run Signal                                                   | File to create or edit          |
   | -------------------------------------------------------------------- | ------------------------------- |
   | Running locally from source with the default development environment | `config/local-development.json` |
   | Building a packaged application for users                            | `config/local-production.json`  |

   These are JSON configuration files, not `.env` files. The OAuth integration
   does not read client settings from a `.env` file. These local configuration
   files are already ignored by Git, so each developer or build environment must
   supply its own copy.

7. **Add the configuration below.** If the file is new, paste the entire example.
   If it already contains settings, add `vanguardOAuth` alongside the existing
   top-level keys; keep the other settings intact.

   ```json
   {
     "vanguardOAuth": {
       "issuer": "https://YOUR-VANGUARD-HOST",
       "clientId": "PASTE-YOUR-APPLICATION-UID-HERE",
       "callbackPort": 47839,
       "requestWriteAccess": true
     }
   }
   ```

   Replace `issuer` with your Vanguard website's HTTPS origin, for example
   `https://vanguard.example.org`. Do not include `/oauth/applications/new`,
   `/api`, or any other path. Replace `clientId` with the value from step 5.
   Keep `callbackPort` at `47839` to match step 2 and `requestWriteAccess` set to
   `true` so Signal requests the write scopes registered above. Do not add a
   `clientSecret` key.

   **Running Vanguard locally:** when Signal runs from source in the development
   environment, `issuer` may use HTTP on `localhost`, `127.0.0.1`, or `[::1]`,
   for example `"issuer": "http://localhost:5000"`. Use a plain URL, without
   Markdown link syntax. Vanguard's discovery issuer and OAuth endpoints must
   use that same origin. Packaged apps and all other environments still require
   HTTPS, as do non-loopback servers. The callback address in step 2 stays the same.

8. **Save the file and restart your custom Signal Desktop app.** For an already
   built development checkout, fully quit Signal and run `pnpm start` from the
   project root. If you have not built the updated code yet, run `pnpm build:dev`
   first using the project's usual development prerequisites.

   For a packaged app, supply `config/local-production.json` **before building
   the package**, then rebuild and install it. The standard release script uses
   `SIGNAL_ENV=production` and includes that file in the package. Changing the
   checkout's configuration does not change an app you have already installed.

## Sign in and check the connection

9. **In your custom Signal build, open Settings → Vanguard.** Find **Vanguard
   organization account** and click **Connect Vanguard**. Complete Vanguard login,
   two-factor authentication, and consent in your browser. Return to Signal and
   check that it shows **Connected**, your Vanguard identity, and your authorized
   organization scopes. Confirm that it shows **Mapping write access**. Your
   Vanguard user must also have permission to manage mappings within the relevant
   organization; registering OAuth scopes alone does not grant that permission.

   Quit and reopen Signal, then revisit this panel to confirm the connection was
   saved. Use **Disconnect** to remove the saved connection. If remote revocation
   fails, Signal will tell you to revoke the application in Vanguard as well.

## If something does not work

| What you see                                                             | What to check                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Vanguard sidebar item in Settings                                     | Use the custom build containing this integration. If the Vanguard page says it is not configured, check the configuration filename for your environment and restart Signal.                     |
| Invalid configuration                                                    | Check the JSON, HTTPS website origin, and client ID. Remove any `clientSecret` key.                                                                                                             |
| Redirect URI rejected                                                    | Compare the registered URI with step 2 exactly. If Vanguard disallows it, its administrator must allow this specific loopback callback.                                                         |
| Sign-in succeeds in the browser, but Signal cannot verify the connection | Ask the Vanguard developer to check the context endpoint, scopes, and discovery configuration in the linked provider requirements.                                                              |
| Secure storage error                                                     | Unlock or enable your OS credential store. On Linux, a real secret-store backend is required; `basic_text` is unsupported. Signal saves tokens automatically—you do not paste them into a file. |
| Callback port already in use                                             | Choose another port between 1024 and 65535, change it in both the registered Redirect URI and `callbackPort`, then restart Signal.                                                              |

## If you already connected with read-only access

Edit the Vanguard application's **Scopes** to match step 4, set
`requestWriteAccess` to `true` in the Signal configuration file, and restart
(or rebuild the packaged app). Click **Reconnect Vanguard** to authorize the
additional access. If the panel still shows read-only access, ask the Vanguard
administrator to check your user's mapping-management permissions and the granted
OAuth scopes.

This setup authorizes the intended read/write workflow. Chunk 2 provides the
connection and permission display; the mapping-write operations are implemented
in a later chunk.

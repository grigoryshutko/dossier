# ChatGPT plan connection (personal self-hosted fork)

This fork adds OpenAI's Sign in with ChatGPT token-sharing flow for a personal, user-controlled Dossier installation. It does not provide a general commercial hosted-service integration.

## Connect your VPS

1. Open Dossier Settings → AI provider and download the sign-in helper.
2. On the computer running your browser, with Node.js 24 installed, run:

   ```sh
   node chatgpt-login.mjs --dossier-origin https://srv1475189.hstgr.cloud
   ```

   For another installation, substitute its exact HTTPS origin. The independently supplied origin prevents a pairing link from redirecting credentials to another server.
3. Click **Continue with ChatGPT** in Dossier and approve the requested OpenAI access yourself. OpenAI's loopback callback runs on your computer at `http://127.0.0.1:1455/auth/callback`. The helper transfers credentials directly over HTTPS to your Dossier server using a one-use, ten-minute pairing capability, then exits.
4. Choose a model from the account's live model catalog and test the connection. An identity-only sign-in is shown separately and cannot run AI tasks.
5. Optionally enable background use for scheduled agent scoring/drafting and automatic mail classification. This is off by default; manual actions remain available without background consent.

After the initial helper setup, the settings button starts a new authorization attempt. The helper must be running for reconnection. This is not a remote HTTPS OAuth callback: OpenAI's public self-hosted flow requires the local callback.

## What uses the allowance

The shared AI provider covers posting extraction and scoring, profile import, application drafting, document refinement, mail classification, and agent scoring/drafting. Startup discovery/matching uses source retrieval and deterministic rules; drafting an application from a startup uses the selected AI provider. Find Jobs still needs its existing JSearch/Adzuna source credentials. ChatGPT authorization does not supply those third-party services.

Responses are streamed through the official `https://api.openai.com/v1/responses` endpoint with `store: false`. Models come from the authorized account's catalog; there is no hard-coded plan entitlement. Incomplete streams and plan-limit failures fail the task. An inference error never retries through a paid API-key provider.

## Credentials and disconnect

The VPS stores credentials atomically in `/data/chatgpt-plan/credentials.json` (or `DOSSIER_DATA_DIR/chatgpt-plan/credentials.json`) with file mode 0600 and directory mode 0700. Refresh-token rotation is serialized across server processes. Credentials are not in the database, Dossier exports, or its database backups. Protect this directory from separate whole-volume/server backups and restrict server access. The local helper retains only a stable host identifier, not access or refresh tokens.

Disconnect attempts OpenAI revocation and clears local tokens and pending pairing capabilities even when revocation is unavailable. The UI reports an unconfirmed remote revocation. Registration identity is retained to reconnect the same app/account; this personal fork does not support switching accounts in place. Delete Everything also disconnects the plan. Use OpenAI's account controls to remove the connection independently when necessary.

Prompts send the information needed for the selected AI task, including relevant profile, posting, draft, or mail text, to OpenAI. This connection does not import ChatGPT conversation history. Existing API-key/local providers remain selectable separately.

Official references: [Open-source token sharing](https://developers.openai.com/siwc/token-sharing-open-source), [Sign-in flow](https://developers.openai.com/siwc/sign-in), [Self-hosted VMs](https://developers.openai.com/siwc/self-hosted-vms), and [models/inference](https://developers.openai.com/siwc/models-and-inference). The HTTPS pairing transport is this fork's implementation of a secure transfer to the user-controlled VPS.

#!/usr/bin/env node
// One-time helper to mint a Gmail OAuth refresh token for Sorted.
//
// Prerequisites (do these once in Google Cloud Console — see the plan/README):
//   1. Enable the Gmail API.
//   2. OAuth consent screen → User type "Internal".
//   3. Create an OAuth client ID of type "Desktop app".
//   4. Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env.
//
// Then run:  npm run gmail-auth -w packages/server
// Log in AS docs@vpatellaw.com, approve, and paste the printed refresh token
// into .env as GOOGLE_REFRESH_TOKEN.

import http from 'node:http';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}`;

// Minimal .env loader (avoids a dotenv dependency in a standalone script).
function loadEnv() {
  const envPath = resolve(process.cwd(), '.env');
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No .env at cwd — fall back to process env / package dir
    try {
      const text = readFileSync(resolve(process.cwd(), '../../.env'), 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {
      /* ignore */
    }
  }
}

loadEnv();

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    'Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Add them to .env first.',
  );
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, REDIRECT_URI);
  const code = reqUrl.searchParams.get('code');
  const error = reqUrl.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorization failed: ${error}`);
    console.error('Authorization failed:', error);
    server.close();
    process.exit(1);
    return;
  }
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('No authorization code received.');
    return;
  }

  try {
    const tokens = await exchangeCode(code);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<h2>✅ Authorized.</h2><p>You can close this tab and return to the terminal.</p>',
    );

    if (tokens.refresh_token) {
      console.log('\n────────────────────────────────────────────────────');
      console.log('SUCCESS. Add this line to your .env:\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('────────────────────────────────────────────────────\n');
    } else {
      console.error(
        '\nNo refresh_token returned. This usually means you already granted ' +
          'consent. Revoke the app at https://myaccount.google.com/permissions ' +
          'and run this again (prompt=consent forces a fresh token).',
      );
    }
  } catch (err) {
    console.error(err);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log('\nOpen this URL in your browser and log in AS docs@vpatellaw.com:\n');
  console.log(authUrl.toString());
  console.log(`\nWaiting for the redirect on ${REDIRECT_URI} ...`);
});

// Gmail REST API client. Mirrors the dropbox.ts pattern: raw fetch, OAuth
// refresh-token flow with an in-memory access-token cache + concurrent-refresh
// lock. No googleapis SDK dependency.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const PROCESSED_LABEL_NAME = 'Sorted/Processed';

let accessToken = '';
let tokenExpiresAt = 0;
let refreshPromise: Promise<string> | null = null;
let cachedLabelId: string | null = null;

export function isConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN,
  );
}

async function getAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('No Gmail credentials configured');
  }

  if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
    return accessToken; // still valid (with 60s buffer)
  }

  // Prevent concurrent refresh calls — share the same promise
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gmail token refresh failed: ${err}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    console.log('[gmail] Token refreshed, expires in', data.expires_in, 'seconds');
    return accessToken;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function gmailApi(
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string> },
): Promise<Response> {
  const token = await getAccessToken();
  const query = init?.query ? `?${new URLSearchParams(init.query).toString()}` : '';
  return fetch(`${GMAIL_API}${path}${query}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
}

export async function isConnected(): Promise<boolean> {
  try {
    const res = await gmailApi('/profile');
    return res.ok;
  } catch {
    return false;
  }
}

/** Find (or create) the "Sorted/Processed" label and cache its id. */
export async function ensureProcessedLabel(): Promise<string> {
  if (cachedLabelId) return cachedLabelId;

  const listRes = await gmailApi('/labels');
  if (!listRes.ok) {
    throw new Error(`Gmail list labels failed: ${await listRes.text()}`);
  }
  const { labels = [] } = (await listRes.json()) as {
    labels?: Array<{ id: string; name: string }>;
  };
  const existing = labels.find((l) => l.name === PROCESSED_LABEL_NAME);
  if (existing) {
    cachedLabelId = existing.id;
    return existing.id;
  }

  const createRes = await gmailApi('/labels', {
    method: 'POST',
    body: {
      name: PROCESSED_LABEL_NAME,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  if (!createRes.ok) {
    throw new Error(`Gmail create label failed: ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { id: string };
  cachedLabelId = created.id;
  return created.id;
}

/** List message ids matching a Gmail search query (handles pagination). */
export async function listMessageIds(query: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const q: Record<string, string> = { q: query, maxResults: '100' };
    if (pageToken) q.pageToken = pageToken;
    const res = await gmailApi('/messages', { query: q });
    if (!res.ok) {
      throw new Error(`Gmail list messages failed: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    };
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return ids;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailPart;
}

export async function getMessage(id: string): Promise<GmailMessage> {
  const res = await gmailApi(`/messages/${id}`, { query: { format: 'full' } });
  if (!res.ok) {
    throw new Error(`Gmail get message ${id} failed: ${await res.text()}`);
  }
  return (await res.json()) as GmailMessage;
}

export async function getAttachment(
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await gmailApi(`/messages/${messageId}/attachments/${attachmentId}`);
  if (!res.ok) {
    throw new Error(`Gmail get attachment failed: ${await res.text()}`);
  }
  const data = (await res.json()) as { data: string };
  // Gmail returns base64url-encoded data
  return Buffer.from(data.data, 'base64url');
}

export async function addLabel(messageId: string, labelId: string): Promise<void> {
  const res = await gmailApi(`/messages/${messageId}/modify`, {
    method: 'POST',
    body: { addLabelIds: [labelId] },
  });
  if (!res.ok) {
    throw new Error(`Gmail add label failed: ${await res.text()}`);
  }
}

/** Add a label to many messages at once (up to 1000 per call). Used for the
 *  one-time baseline so we don't make thousands of per-message calls. */
export async function batchAddLabel(ids: string[], labelId: string): Promise<void> {
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const res = await gmailApi('/messages/batchModify', {
      method: 'POST',
      body: { ids: chunk, addLabelIds: [labelId] },
    });
    if (!res.ok) {
      throw new Error(`Gmail batchModify failed: ${await res.text()}`);
    }
  }
}

export function getHeader(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

export interface ExtractedAttachment {
  filename: string;
  attachmentId: string;
  mimeType: string;
  size: number;
}

const DEFAULT_INLINE_IMAGE_MIN_BYTES = 10_000;

/** Recursively collect real file attachments from a message payload, skipping
 *  inline images (signature logos, tracking pixels) and tiny images. */
export function extractAttachments(payload: GmailPart | undefined): ExtractedAttachment[] {
  const minImageBytes =
    Number(process.env.GMAIL_INLINE_IMAGE_MIN_BYTES) || DEFAULT_INLINE_IMAGE_MIN_BYTES;
  const out: ExtractedAttachment[] = [];

  const walk = (part?: GmailPart) => {
    if (!part) return;
    if (part.parts) {
      for (const p of part.parts) walk(p);
    }

    const attachmentId = part.body?.attachmentId;
    const filename = part.filename?.trim();
    if (!attachmentId || !filename) return;

    const disposition = (getHeader(part.headers, 'Content-Disposition') ?? '').toLowerCase();
    const hasContentId = Boolean(getHeader(part.headers, 'Content-ID'));
    const mimeType = part.mimeType ?? 'application/octet-stream';
    const size = part.body?.size ?? 0;
    const isImage = mimeType.startsWith('image/');
    const isAttachment = disposition.includes('attachment');

    // The "embedded junk" heuristics (inline / Content-ID / tiny-size) exist to
    // drop signature logos, tracking pixels and inline graphics. They must apply
    // ONLY to images that are NOT explicit attachments. Everything else is a real
    // document and is always kept:
    //   - any part with Content-Disposition: attachment (any type, any size), and
    //   - any non-image part with a filename (pdf/docx/etc.) even if marked inline
    //     or sent with no disposition at all.
    // (Gmail also stamps a Content-ID on genuine attachments, so Content-ID alone
    // never disqualifies anything.)
    if (!isAttachment && isImage) {
      if (disposition.includes('inline')) return;        // embedded inline image
      if (hasContentId) return;                           // cid-referenced embedded image
      if (size > 0 && size < minImageBytes) return;       // tracking pixel / tiny icon
    }

    out.push({ filename, attachmentId, mimeType, size });
  };

  walk(payload);
  return out;
}

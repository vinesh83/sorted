import { PARALEGAL_FOLDERS, type ParalegalName } from 'shared/types.js';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';

let accessToken = '';
let tokenExpiresAt = 0;
let rootNamespaceId = '';

async function getAccessToken(): Promise<string> {
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

  // If we have refresh token credentials, use OAuth refresh flow
  if (appKey && appSecret && refreshToken) {
    if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
      return accessToken; // still valid (with 60s buffer)
    }

    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: appKey,
        client_secret: appSecret,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Dropbox token refresh failed: ${err}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    console.log('[dropbox] Token refreshed, expires in', data.expires_in, 'seconds');
    return accessToken;
  }

  // Fallback to static access token from env (short-lived, for development)
  // Read lazily since dotenv loads after module init
  const envToken = process.env.DROPBOX_ACCESS_TOKEN;
  if (envToken) {
    accessToken = envToken;
    return accessToken;
  }

  throw new Error('No Dropbox credentials configured');
}

/** Detect root namespace for team Dropbox accounts (needed to access full paths) */
async function ensureRootNamespace(token: string): Promise<void> {
  if (rootNamespaceId) return;
  try {
    const res = await fetch(`${DROPBOX_API}/users/get_current_account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        root_info: { '.tag': string; root_namespace_id: string; home_namespace_id: string };
      };
      // For team accounts, use the home namespace so paths resolve relative to user's home
      if (data.root_info.root_namespace_id !== data.root_info.home_namespace_id) {
        rootNamespaceId = data.root_info.home_namespace_id;
        console.log('[dropbox] Team account detected, using home namespace:', rootNamespaceId);
      }
    }
  } catch {
    // Non-critical, continue without namespace header
  }
}

function getPathRootHeader(): Record<string, string> {
  if (!rootNamespaceId) return {};
  return { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', 'root': rootNamespaceId }) };
}

async function dropboxApi(endpoint: string, body?: unknown): Promise<Response> {
  const token = await getAccessToken();
  await ensureRootNamespace(token);
  const res = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...getPathRootHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

export interface DropboxFileEntry {
  '.tag': 'file';
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
  size: number;
  content_hash: string;
}

interface ListFolderResult {
  entries: Array<DropboxFileEntry | { '.tag': string; [key: string]: unknown }>;
  cursor: string;
  has_more: boolean;
}

export async function listFolder(path: string): Promise<{ entries: DropboxFileEntry[]; cursor: string }> {
  const allEntries: DropboxFileEntry[] = [];

  const res = await dropboxApi('/files/list_folder', {
    path,
    recursive: false,
    include_deleted: false,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox list_folder failed for ${path}: ${err}`);
  }

  let result = (await res.json()) as ListFolderResult;
  allEntries.push(...result.entries.filter((e): e is DropboxFileEntry => e['.tag'] === 'file'));

  while (result.has_more) {
    const contRes = await dropboxApi('/files/list_folder/continue', { cursor: result.cursor });
    if (!contRes.ok) break;
    result = (await contRes.json()) as ListFolderResult;
    allEntries.push(...result.entries.filter((e): e is DropboxFileEntry => e['.tag'] === 'file'));
  }

  return { entries: allEntries, cursor: result.cursor };
}

export async function listFolderContinue(cursor: string): Promise<{ entries: DropboxFileEntry[]; cursor: string }> {
  const allEntries: DropboxFileEntry[] = [];

  const res = await dropboxApi('/files/list_folder/continue', { cursor });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox list_folder/continue failed: ${err}`);
  }

  let result = (await res.json()) as ListFolderResult;
  allEntries.push(...result.entries.filter((e): e is DropboxFileEntry => e['.tag'] === 'file'));

  while (result.has_more) {
    const contRes = await dropboxApi('/files/list_folder/continue', { cursor: result.cursor });
    if (!contRes.ok) break;
    result = (await contRes.json()) as ListFolderResult;
    allEntries.push(...result.entries.filter((e): e is DropboxFileEntry => e['.tag'] === 'file'));
  }

  return { entries: allEntries, cursor: result.cursor };
}

export async function downloadFile(path: string): Promise<Buffer> {
  const token = await getAccessToken();
  await ensureRootNamespace(token);
  const res = await fetch(`${DROPBOX_CONTENT}/files/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
      ...getPathRootHeader(),
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox download failed for ${path}: ${err}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export function getMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc': return 'application/msword';
    default: return 'application/octet-stream';
  }
}

export async function isConnected(): Promise<boolean> {
  try {
    const token = await getAccessToken();
    const res = await fetch(`${DROPBOX_API}/users/get_current_account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function getParalegalFolders(): Array<{ name: ParalegalName; path: string }> {
  return (Object.entries(PARALEGAL_FOLDERS) as Array<[ParalegalName, string]>).map(
    ([name, path]) => ({ name, path }),
  );
}

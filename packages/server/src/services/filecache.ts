import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data', 'cache');

// Ensure cache dir exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePath(processedFileId: number): string {
  return path.join(CACHE_DIR, String(processedFileId));
}

export function getCached(processedFileId: number): Buffer | null {
  const p = cachePath(processedFileId);
  if (fs.existsSync(p)) {
    return fs.readFileSync(p);
  }
  return null;
}

export function putCache(processedFileId: number, buffer: Buffer): void {
  try {
    fs.writeFileSync(cachePath(processedFileId), buffer);
  } catch (err) {
    console.error(`[filecache] Failed to cache file ${processedFileId}:`, err);
  }
}

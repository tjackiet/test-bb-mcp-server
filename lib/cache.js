// lib/cache.js
import fs from 'fs';
import path from 'path';

const CACHE_DIR = './cache';
const DEFAULT_TTL = 3600 * 1000; // 1時間

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
  }
}

function getCachePath(key) {
  // ファイル名として使えない文字をエスケープ
  const safeKey = key.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(CACHE_DIR, `${safeKey}.json`);
}

export function getCache(key) {
  ensureCacheDir();
  const filePath = getCachePath(key);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stat = fs.statSync(filePath);
    const now = new Date().getTime();
    const mtime = new Date(stat.mtime).getTime();

    if (now - mtime > DEFAULT_TTL) {
      // TTL切れ
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`[Cache] Failed to read cache for key: ${key}`, error);
    return null;
  }
}

export function setCache(key, data) {
  ensureCacheDir();
  const filePath = getCachePath(key);

  try {
    const content = JSON.stringify(data);
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (error) {
    console.error(`[Cache] Failed to write cache for key: ${key}`, error);
  }
}

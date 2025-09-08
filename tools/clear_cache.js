// tools/clear_cache.js
import fs from 'fs';
import path from 'path';

const CACHE_DIR = './cache';

function clearCache() {
  if (!fs.existsSync(CACHE_DIR)) {
    console.log('Cache directory does not exist. Nothing to do.');
    return;
  }

  try {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    console.log(`✔ Successfully cleared cache directory: ${path.resolve(CACHE_DIR)}`);
  } catch (error) {
    console.error(`Failed to clear cache: ${error}`);
    process.exit(1);
  }
}

clearCache();

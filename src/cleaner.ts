import fs from 'node:fs';
import path from 'node:path';

const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), 'temp_downloads');
const EXPIRATION_MINUTES = parseInt(process.env.FILE_EXPIRATION_MINUTES || '15', 10);
const CLEANUP_INTERVAL_MINUTES = parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '5', 10);

export function initTempDirectory() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log(`[CLEANER] Created ephemeral media directory: ${TEMP_DIR}`);
  }
}

export function startAutoCleaner() {
  initTempDirectory();

  console.log(`[CLEANER] Initialized daemon: checking every ${CLEANUP_INTERVAL_MINUTES} min, purging files > ${EXPIRATION_MINUTES} min.`);

  setInterval(() => {
    try {
      if (!fs.existsSync(TEMP_DIR)) return;

      const files = fs.readdirSync(TEMP_DIR);
      const now = Date.now();
      const maxAgeMs = EXPIRATION_MINUTES * 60 * 1000;
      let purgedCount = 0;

      for (const file of files) {
        const filePath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filePath);

        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          purgedCount++;
        }
      }

      if (purgedCount > 0) {
        console.log(`[CLEANER] Purged ${purgedCount} expired media files.`);
      }
    } catch (err) {
      console.error('[CLEANER ERROR] Failed running cleanup loop:', err);
    }
  }, CLEANUP_INTERVAL_MINUTES * 60 * 1000);
}

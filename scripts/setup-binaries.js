import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const binDir = path.resolve(__dirname, '..', 'bin');

if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

const targetPath = path.join(binDir, 'yt-dlp.exe');

function downloadFile(url, dest, callback) {
  console.log(`Downloading ${url}...`);
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      console.log(`Following redirect to ${res.headers.location}...`);
      return downloadFile(res.headers.location, dest, callback);
    }

    if (res.statusCode !== 200) {
      return callback(new Error(`Download failed with status: ${res.statusCode}`));
    }

    const file = fs.createWriteStream(dest);
    res.pipe(file);

    file.on('finish', () => {
      file.close(() => {
        console.log(`✓ Successfully downloaded to ${dest}`);
        callback(null);
      });
    });

    file.on('error', (err) => {
      fs.unlink(dest, () => {});
      callback(err);
    });
  }).on('error', (err) => {
    callback(err);
  });
}

if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size < 1000000) {
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  downloadFile(url, targetPath, (err) => {
    if (err) {
      console.error('Failed to download yt-dlp.exe:', err.message);
      process.exit(1);
    } else {
      console.log('yt-dlp.exe is ready in backend/bin/!');
    }
  });
} else {
  console.log(`yt-dlp.exe already exists at ${targetPath}`);
}

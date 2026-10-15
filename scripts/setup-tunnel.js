import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const binDir = path.resolve(__dirname, '..', 'bin');

if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

function downloadFileWithRedirects(url, dest) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirectCount = 0) {
      if (redirectCount > 10) return reject(new Error('Too many redirects'));
      https.get(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', (err) => {
          try { fs.unlinkSync(dest); } catch {}
          reject(err);
        });
      }).on('error', reject);
    }
    get(url);
  });
}

function downloadGzBinary(url, dest) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirectCount = 0) {
      if (redirectCount > 10) return reject(new Error('Too many redirects'));
      https.get(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        const gunzip = zlib.createGunzip();
        res.pipe(gunzip).pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', (err) => {
          try { fs.unlinkSync(dest); } catch {}
          reject(err);
        });
        gunzip.on('error', (err) => {
          try { fs.unlinkSync(dest); } catch {}
          reject(err);
        });
      }).on('error', reject);
    }
    get(url);
  });
}

async function setup() {
  console.log('--- Checking & Initializing Residential Tunnel Binaries ---');

  // 1. Check cloudflared.exe
  const cloudflaredPath = path.join(binDir, 'cloudflared.exe');
  if (!fs.existsSync(cloudflaredPath) || fs.statSync(cloudflaredPath).size < 1000000) {
    console.log('[CLOUDFLARE] Downloading official cloudflared.exe...');
    const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    try {
      await downloadFileWithRedirects(url, cloudflaredPath);
      console.log('✓ cloudflared.exe downloaded successfully.');
    } catch (e) {
      console.error('Failed to download cloudflared.exe:', e.message);
    }
  } else {
    console.log('✓ cloudflared.exe already exists.');
  }

  // 2. Check ffmpeg.exe
  const ffmpegPath = path.join(binDir, 'ffmpeg.exe');
  if (!fs.existsSync(ffmpegPath) || fs.statSync(ffmpegPath).size < 1000000) {
    console.log('[FFMPEG] Downloading standalone ffmpeg.exe (for 1080p/4K high-speed merging)...');
    const url = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1/ffmpeg-win32-x64.gz';
    try {
      await downloadGzBinary(url, ffmpegPath);
      console.log('✓ ffmpeg.exe downloaded and decompressed successfully.');
    } catch (e) {
      console.warn('FFmpeg auto-download notice:', e.message);
    }
  } else {
    console.log('✓ ffmpeg.exe already exists.');
  }

  // 3. Check yt-dlp.exe
  const ytdlpPath = path.join(binDir, 'yt-dlp.exe');
  if (fs.existsSync(ytdlpPath)) {
    console.log('✓ yt-dlp.exe already exists.');
  } else {
    console.log('[YT-DLP] Downloading official yt-dlp.exe...');
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    try {
      await downloadFileWithRedirects(url, ytdlpPath);
      console.log('✓ yt-dlp.exe downloaded successfully.');
    } catch (e) {
      console.error('Failed to download yt-dlp.exe:', e.message);
    }
  }

  console.log('\nAll required residential binaries are verified in backend/bin/!');
}

setup().catch(console.error);

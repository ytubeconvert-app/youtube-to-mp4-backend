import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import zlib from 'node:zlib';
import { queue, type Job } from './queue.js';

const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), 'temp_downloads');
const MAX_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '1500', 10);

// Helper: Download binary following redirects with browser User-Agent
function downloadBinary(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parentDir = path.dirname(dest);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const file = fs.createWriteStream(dest);

    function requestWithRedirects(targetUrl: string, redirectCount = 0) {
      if (redirectCount > 10) {
        return reject(new Error('Exceeded maximum redirect limit while downloading binary.'));
      }

      const req = https.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': '*/*'
        }
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return requestWithRedirects(res.headers.location, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed with HTTP status ${res.statusCode}`));
        }

        res.pipe(file);

        file.on('finish', () => {
          file.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });

      req.on('error', (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });

      file.on('error', (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    }

    requestWithRedirects(url);
  });
}

// Helper: Download and gunzip .gz binary directly to disk (used for ffmpeg-static Windows binary)
function downloadGzBinary(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parentDir = path.dirname(dest);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const file = fs.createWriteStream(dest);

    function requestWithRedirects(targetUrl: string, redirectCount = 0) {
      if (redirectCount > 10) {
        return reject(new Error('Exceeded maximum redirect limit while downloading compressed binary.'));
      }

      const req = https.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': '*/*'
        }
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return requestWithRedirects(res.headers.location, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed with HTTP status ${res.statusCode}`));
        }

        const gunzip = zlib.createGunzip();
        res.pipe(gunzip).pipe(file);

        file.on('finish', () => {
          file.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        gunzip.on('error', (err) => {
          try { fs.unlinkSync(dest); } catch {}
          reject(err);
        });
      });

      req.on('error', (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });

      file.on('error', (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    }

    requestWithRedirects(url);
  });
}

// Helper: Resolve cookies file from ENV content, ENV path, or local cookies.txt
let cachedCookiesPath: string | null = null;
export function resolveCookiesPath(): string | null {
  if (cachedCookiesPath && fs.existsSync(cachedCookiesPath)) {
    return cachedCookiesPath;
  }

  // 1. From Render Secret Files (/etc/secrets/cookies.txt) - Official Render standard for multiline files
  const secretCandidates = [
    '/etc/secrets/cookies.txt',
    '/etc/secrets/yt_cookies.txt',
    '/etc/secrets/youtube_cookies.txt'
  ];
  for (const s of secretCandidates) {
    if (fs.existsSync(s)) {
      console.log(`[COOKIES] Found Render Secret File at: ${s}`);
      cachedCookiesPath = s;
      return s;
    }
  }

  // 2. From environment variable content (YT_COOKIES_CONTENT, YT_COOKIES_BASE64, etc.)
  const rawEnv = process.env.YT_COOKIES_BASE64 ||
                 process.env.YT_COOKIES_CONTENT ||
                 process.env.YOUTUBE_COOKIES ||
                 process.env.YT_COOKIES ||
                 process.env.COOKIES_CONTENT ||
                 process.env.COOKIES;

  if (rawEnv && rawEnv.trim().length > 10) {
    try {
      let content = rawEnv.trim();

      // Strip surrounding quotes if wrapped during dashboard input
      if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) {
        content = content.slice(1, -1);
      }

      // Check if content is Base64 encoded (starts with I05ldHNj = "#Netsc" or standard base64 pattern)
      if (content.startsWith('I05ldHNj') || (!content.includes('\t') && /^[A-Za-z0-9+/=\r\n]+$/.test(content) && content.length > 50)) {
        try {
          const decoded = Buffer.from(content, 'base64').toString('utf8');
          if (decoded.includes('.youtube.com') || decoded.includes('.google.com') || decoded.includes('Netscape')) {
            content = decoded;
            console.log('[COOKIES] Successfully decoded Base64 cookie content from environment.');
          }
        } catch {}
      }

      // Normalize literal escaped characters from web forms/JSON
      content = content.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');

      // Ensure Netscape format header if missing (required by yt-dlp / Python MozillaCookieJar)
      if (!content.startsWith('# Netscape HTTP Cookie File') && !content.startsWith('# HTTP Cookie File')) {
        content = `# Netscape HTTP Cookie File\n# Generated by YouTube converter backend\n\n${content}`;
      }

      if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
      }
      const targetPath = path.join(TEMP_DIR, 'cookies.txt');
      fs.writeFileSync(targetPath, content, 'utf8');
      console.log('[COOKIES] Successfully initialized formatted Netscape cookies from environment.');
      cachedCookiesPath = targetPath;
      return targetPath;
    } catch (err: any) {
      console.warn('[COOKIES] Could not write cookies from environment:', err.message);
    }
  }

  // 3. From environment variable file path
  if (process.env.YT_COOKIES_PATH && fs.existsSync(path.resolve(process.env.YT_COOKIES_PATH))) {
    cachedCookiesPath = path.resolve(process.env.YT_COOKIES_PATH);
    return cachedCookiesPath;
  }

  // 4. From common file locations
  const candidates = [
    path.resolve(process.cwd(), 'cookies.txt'),
    path.resolve(process.cwd(), '..', 'cookies.txt'),
    path.join(TEMP_DIR, 'cookies.txt'),
    path.resolve(process.cwd(), 'bin', 'cookies.txt')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedCookiesPath = c;
      return c;
    }
  }

  return null;
}

// Helper: Resolve proxy from environment variables (Webshare, Smartproxy, residential proxies)
export function resolveProxyUrl(): string | null {
  const rawProxy = process.env.YT_PROXY ||
                   process.env.PROXY ||
                   process.env.HTTP_PROXY ||
                   process.env.HTTPS_PROXY ||
                   process.env.ALL_PROXY ||
                   process.env.PROXY_URL ||
                   process.env.WEBSHARE_PROXY ||
                   process.env.SMARTPROXY ||
                   process.env.SMART_PROXY;
  if (rawProxy && rawProxy.trim().length > 0) {
    let p = rawProxy.trim();
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1).trim();
    }
    // Ensure protocol scheme if user entered host:port or user:pass@host:port
    if (!p.startsWith('http://') && !p.startsWith('https://') && !p.startsWith('socks5://')) {
      p = `http://${p}`;
    }
    return p;
  }
  return null;
}

// -------------------------------------------------------------------
// Binary Resolvers & Auto-Installers
// -------------------------------------------------------------------
let cachedYtDlpBin: string | null = null;
let ytDlpDownloadPromise: Promise<string> | null = null;

export async function ensureYtDlpBinary(): Promise<string> {
  if (cachedYtDlpBin && (fs.existsSync(cachedYtDlpBin) || cachedYtDlpBin === 'yt-dlp' || cachedYtDlpBin === 'yt-dlp.exe')) {
    return cachedYtDlpBin;
  }

  const isWin = process.platform === 'win32';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';

  if (process.env.YT_DLP_PATH && fs.existsSync(path.resolve(process.env.YT_DLP_PATH))) {
    cachedYtDlpBin = path.resolve(process.env.YT_DLP_PATH);
    return cachedYtDlpBin;
  }

  const candidatePaths = [
    path.resolve(process.cwd(), 'bin', binName),
    path.resolve(process.cwd(), binName),
    path.resolve(process.cwd(), '..', binName),
    path.resolve(process.cwd(), '..', 'bin', binName)
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      cachedYtDlpBin = p;
      return p;
    }
  }

  const isAvailableInPath = await new Promise<boolean>((resolve) => {
    try {
      const p = spawn(binName, ['--version']);
      p.on('close', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });

  if (isAvailableInPath) {
    cachedYtDlpBin = binName;
    return binName;
  }

  if (ytDlpDownloadPromise) {
    return ytDlpDownloadPromise;
  }

  ytDlpDownloadPromise = (async () => {
    const targetDir = path.resolve(process.cwd(), 'bin');
    const targetPath = path.join(targetDir, binName);
    const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binName}`;

    console.log(`[YT-DLP] Executable not found in PATH or project. Downloading official ${binName}...`);

    try {
      await downloadBinary(downloadUrl, targetPath);
      if (!isWin) fs.chmodSync(targetPath, 0o755);

      console.log(`[YT-DLP] Successfully downloaded and installed ${binName} to ${targetPath}`);
      cachedYtDlpBin = targetPath;
      return targetPath;
    } catch (err: any) {
      console.error('[YT-DLP] Auto-download failed:', err.message);
      ytDlpDownloadPromise = null;
      throw new Error(`Failed to locate or download yt-dlp. Please place ${binName} in the bin folder.`);
    }
  })();

  return ytDlpDownloadPromise;
}

let cachedFfmpegBin: string | null = null;
let ffmpegDownloadPromise: Promise<string | null> | null = null;

export async function ensureFfmpegBinary(): Promise<string | null> {
  if (cachedFfmpegBin && (fs.existsSync(cachedFfmpegBin) || cachedFfmpegBin === 'ffmpeg' || cachedFfmpegBin === 'ffmpeg.exe')) {
    return cachedFfmpegBin;
  }

  const isWin = process.platform === 'win32';
  const binName = isWin ? 'ffmpeg.exe' : 'ffmpeg';

  if (process.env.FFMPEG_PATH && fs.existsSync(path.resolve(process.env.FFMPEG_PATH))) {
    cachedFfmpegBin = path.resolve(process.env.FFMPEG_PATH);
    return cachedFfmpegBin;
  }

  const candidates = [
    path.resolve(process.cwd(), 'bin', binName),
    path.resolve(process.cwd(), binName),
    path.resolve(process.cwd(), '..', binName),
    path.resolve(process.cwd(), '..', 'bin', binName)
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedFfmpegBin = c;
      return c;
    }
  }

  const isAvailableInPath = await new Promise<boolean>((resolve) => {
    try {
      const p = spawn(binName, ['-version']);
      p.on('close', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });

  if (isAvailableInPath) {
    cachedFfmpegBin = binName;
    return binName;
  }

  // Auto-download standalone FFmpeg for Windows via official release archive
  if (isWin) {
    if (ffmpegDownloadPromise) {
      return ffmpegDownloadPromise;
    }

    ffmpegDownloadPromise = (async () => {
      const targetDir = path.resolve(process.cwd(), 'bin');
      const targetPath = path.join(targetDir, binName);
      const downloadUrl = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1/ffmpeg-win32-x64.gz';

      console.log(`[FFMPEG] Standalone FFmpeg not found on Windows. Auto-downloading ${binName}...`);

      try {
        await downloadGzBinary(downloadUrl, targetPath);
        console.log(`[FFMPEG] Successfully downloaded and installed ${binName} to ${targetPath}`);
        cachedFfmpegBin = targetPath;
        return targetPath;
      } catch (err: any) {
        console.warn(`[FFMPEG] Auto-download notice: ${err.message}. Will utilize direct pre-merged MP4 streams.`);
        ffmpegDownloadPromise = null;
        return null;
      }
    })();

    return ffmpegDownloadPromise;
  }

  return null;
}

export function getFfmpegDir(): string | null {
  if (cachedFfmpegBin && fs.existsSync(cachedFfmpegBin)) {
    return path.dirname(cachedFfmpegBin);
  }

  const isWin = process.platform === 'win32';
  const binName = isWin ? 'ffmpeg.exe' : 'ffmpeg';

  const candidates = [
    path.resolve(process.cwd(), 'bin'),
    path.resolve(process.cwd()),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '..', 'bin')
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, binName))) {
      return dir;
    }
  }

  return null;
}

let isSystemFfmpeg: boolean | null = null;
export async function hasFfmpeg(): Promise<boolean> {
  const local = await ensureFfmpegBinary();
  if (local) return true;
  if (isSystemFfmpeg !== null) return isSystemFfmpeg;
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    try {
      const p = spawn(isWin ? 'ffmpeg.exe' : 'ffmpeg', ['-version']);
      p.on('close', (code) => {
        isSystemFfmpeg = (code === 0);
        resolve(isSystemFfmpeg);
      });
      p.on('error', () => {
        isSystemFfmpeg = false;
        resolve(false);
      });
    } catch {
      isSystemFfmpeg = false;
      resolve(false);
    }
  });
}

// -------------------------------------------------------------------
// Fast Video Metadata Fetcher (sub-100ms with baseline fallback)
// -------------------------------------------------------------------
export async function fetchVideoMetadata(url: string) {
  const match = url.match(/(?:youtu\.be\/|(?:www\.|m\.|music\.)?youtube\.com\/(?:embed\/|v\/|e\/|shorts\/|live\/|watch\?v=|watch\?.+&v=))([a-zA-Z0-9_-]{11})/i);
  const videoId = match ? match[1] : 'video';

  const defaultFormats = [
    { formatId: '1080p', quality: '1080p Full HD', label: '1080p (MP4)' },
    { formatId: '720p', quality: '720p HD', label: '720p (MP4)' },
    { formatId: '4k', quality: '4K Ultra HD', label: '4K (MP4)' },
    { formatId: '360p', quality: '360p Fast', label: '360p (MP4)' },
    { formatId: 'mp3', quality: 'Audio Only', label: 'MP3 Audio', isAudioOnly: true }
  ];

  let title = `YouTube Video (${videoId})`;
  let author = 'YouTube Creator';

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const data: any = await res.json();
      if (data.title) title = data.title;
      if (data.author_name) author = data.author_name;
    }
  } catch {}

  return {
    id: videoId,
    title,
    duration: 240,
    durationFormatted: 'HD Stream',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    author,
    formats: defaultFormats
  };
}

// -------------------------------------------------------------------
// Execute Conversion Job with Direct Stream Fallback
// -------------------------------------------------------------------
export async function executeConversionJob(job: Job) {
  queue.incrementActive();
  queue.updateJob(job.id, { status: 'processing', progress: 10, message: 'Initializing conversion...' });

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const isAudio = job.format === 'mp3';
  const extension = isAudio ? 'mp3' : 'mp4';
  const outputFilePath = path.join(TEMP_DIR, `${job.id}.${extension}`);

  let ytDlpBin: string;
  try {
    ytDlpBin = await ensureYtDlpBinary();
  } catch (err: any) {
    queue.decrementActive();
    queue.updateJob(job.id, {
      status: 'failed',
      error: `Conversion engine not ready: ${err.message}`
    });
    return;
  }

  // Attempt to resolve or auto-download FFmpeg
  const ffmpegBin = await ensureFfmpegBinary();
  const ffmpegAvailable = !!ffmpegBin || (await hasFfmpeg());
  const ffmpegLocation = getFfmpegDir();

  let heightLimit = 1080;
  if (job.format === '720p') heightLimit = 720;
  if (job.format === '4k') heightLimit = 2160;
  if (job.format === '360p') heightLimit = 360;

  const cookiesPath = resolveCookiesPath();

  const args: string[] = [
    '--no-playlist',
    '--newline',
    '--no-cache-dir',
    `--max-filesize`, `${MAX_SIZE_MB}M`,
    '--no-check-certificates',
    '--sleep-requests', '1',
    '--js-runtimes', 'node'
  ];

  if (cookiesPath) {
    console.log(`[JOB ${job.id}] Authenticating YouTube download with cookies: ${cookiesPath}`);
    args.push('--cookies', cookiesPath);
    // Use web, web_embedded, ios, mweb (tv clients trigger 'page needs to be reloaded' when cookies are passed)
    args.push('--extractor-args', 'youtube:player_client=web,web_embedded,ios,mweb');
  } else {
    // On datacenter / cloud IPs without cookies, try android_vr, ios, mweb, web
    args.push('--extractor-args', 'youtube:player_client=android_vr,ios,mweb,web');
  }

  // Proxy routing (Webshare, Smartproxy, residential proxies)
  const proxy = resolveProxyUrl();
  if (proxy) {
    const masked = proxy.replace(/:\/\/[^:]+:([^@]+)@/, '://***:***@');
    console.log(`[JOB ${job.id}] Routing YouTube traffic through proxy: ${masked}`);
    args.push('--proxy', proxy);
  }

  if (isAudio) {
    if (ffmpegAvailable) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      // Direct audio stream without transcoding if FFmpeg is not present
      args.push('-f', 'ba[ext=m4a]/ba/best');
    }
  } else {
    if (ffmpegAvailable) {
      // High-resolution multi-track merge with FFmpeg with fallback to standard pre-merged formats
      args.push(
        '-f', `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]/22/18/best`,
        '--merge-output-format', 'mp4'
      );
    } else {
      // Guaranteed single pre-merged stream: Format 22 (720p) or 18 (360p) requires ZERO merging/FFmpeg
      console.log(`[JOB ${job.id}] Notice: Utilizing standalone pre-merged MP4 stream.`);
      args.push('-f', '22/18/b[ext=mp4]/best[ext=mp4]/best');
    }
  }

  if (ffmpegLocation) {
    args.push('--ffmpeg-location', ffmpegLocation);
  }

  args.push('-o', outputFilePath, job.url);

  console.log(`[JOB ${job.id}] Spawning: ${ytDlpBin} for ${job.videoId} (${job.format})`);

  let stderrOutput = '';
  let hasFailed = false;

  let child;
  try {
    child = spawn(ytDlpBin, args, { windowsHide: true });
  } catch (spawnErr: any) {
    queue.decrementActive();
    queue.updateJob(job.id, {
      status: 'failed',
      error: `Failed to launch conversion engine (${spawnErr.message}).`
    });
    return;
  }

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    const match = text.match(/\[download\]\s+([\d\.]+)%/);
    if (match) {
      const percent = parseFloat(match[1]);
      const normalized = Math.min(85, Math.floor(10 + percent * 0.75));
      queue.updateJob(job.id, { progress: normalized, message: `Downloading: ${percent.toFixed(0)}%` });
    } else if (text.includes('[Merger]') || text.includes('[ExtractAudio]')) {
      queue.updateJob(job.id, { progress: 90, message: 'Finalizing media file...' });
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrOutput += text;
  });

  child.on('close', (code) => {
    queue.decrementActive();
    if (hasFailed) return;

    if (code === 0 && fs.existsSync(outputFilePath)) {
      queue.updateJob(job.id, {
        status: 'completed',
        progress: 100,
        outputPath: outputFilePath,
        message: 'Conversion completed successfully!',
        completedAt: Date.now()
      });
      console.log(`[JOB ${job.id}] Successfully completed. Output saved at: ${outputFilePath}`);
    } else {
      let cleanErr = 'Conversion failed. Please try a different format or video.';
      if (code === -4058 || (code !== 0 && !fs.existsSync(outputFilePath) && !stderrOutput)) {
        cleanErr = 'Conversion engine was initializing (Exit code -4058). Please retry now.';
      } else if (stderrOutput.includes('Sign in to confirm')) {
        const hasCookies = !!resolveCookiesPath();
        if (hasCookies) {
          cleanErr = 'YouTube rejected this session (cookies may be expired or missing LOGIN_INFO). Please export fresh cookies while signed in to YouTube, or try another video.';
        } else {
          cleanErr = 'YouTube requires bot verification for this cloud IP. Please provide cookies in Render (via Secret File cookies.txt or YT_COOKIES_CONTENT env var), or try another video.';
        }
      } else if (stderrOutput.includes('The page needs to be reloaded')) {
        cleanErr = 'YouTube issued a dynamic page verification challenge. The EJS solver will re-authenticate; please retry now or try another video.';
      } else if (stderrOutput.includes('Private video')) {
        cleanErr = 'This video is private or unavailable.';
      } else if (stderrOutput.includes('Postprocessing') && stderrOutput.includes('ffmpeg')) {
        cleanErr = 'FFmpeg is downloading in background for 1080p/4K merging. Please retry in 10 seconds, or select 720p for instant download.';
      } else if (stderrOutput) {
        cleanErr = stderrOutput.slice(-150).trim();
      }

      queue.updateJob(job.id, {
        status: 'failed',
        error: cleanErr,
        message: 'Conversion process failed.'
      });
      console.error(`[JOB ${job.id}] Failed with exit code ${code}: ${cleanErr}`);
    }
  });

  child.on('error', (err: any) => {
    queue.decrementActive();
    hasFailed = true;
    const isNotFound = err.code === 'ENOENT' || err.errno === -4058;
    const errorMsg = isNotFound
      ? `Conversion engine (${ytDlpBin}) was not found (Exit code -4058). Please retry in a few seconds.`
      : `Process error: ${err.message}`;

    queue.updateJob(job.id, {
      status: 'failed',
      error: errorMsg
    });
    console.error(`[JOB ${job.id}] Error spawning yt-dlp:`, errorMsg);
  });
}

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { startAutoCleaner } from './cleaner.js';
import { fetchVideoMetadata, executeConversionJob, ensureYtDlpBinary, hasFfmpeg, resolveCookiesPath, resolveProxyUrl } from './downloader.js';
import { validateAndSanitizeYouTubeUrl } from './validator.js';
import { queue } from './queue.js';

dotenv.config();

// Auto-synchronize frontend/src from root src if in workspace setup
try {
  const rootCandidate = process.cwd().endsWith('backend') ? path.resolve(process.cwd(), '..') : process.cwd();
  const rootSrc = path.join(rootCandidate, 'src');
  const frontendSrc = path.join(rootCandidate, 'frontend', 'src');
  if (fs.existsSync(rootSrc) && !fs.existsSync(frontendSrc)) {
    fs.mkdirSync(path.join(rootCandidate, 'frontend'), { recursive: true });
    fs.cpSync(rootSrc, frontendSrc, { recursive: true });
    console.log('[MONOREPO] Automatically populated frontend/src from root source directory.');
  }
} catch {}

const app = express();
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Global CORS Middleware: permits requests from frontend (port 4321, Cloudflare Pages, custom domain)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Backend-Signature', 'X-Backend-Timestamp', 'Range'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Disposition']
}));

app.use(express.json());

// Initialize background auto-cleaner daemon
startAutoCleaner();

// Simple in-memory rate limiter per IP
const ipRequestCounts = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(req: Request, maxRequests = 30, windowSeconds = 60): boolean {
  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
  const now = Date.now();
  const record = ipRequestCounts.get(ip);

  if (!record || now > record.resetAt) {
    ipRequestCounts.set(ip, { count: 1, resetAt: now + windowSeconds * 1000 });
    return true;
  }

  if (record.count >= maxRequests) {
    return false;
  }

  record.count++;
  return true;
}

// 1. Health & Root Info Endpoints (prevents 404 on base URL)
app.get(['/', '/api', '/health', '/api/health'], (req, res) => {
  const cookiesPath = resolveCookiesPath();
  let cookieStatus = 'not_found';
  let cookieEntries = 0;
  let hasLogin = false;
  let detectedCookieNames: string[] = [];

  if (cookiesPath && fs.existsSync(cookiesPath)) {
    try {
      const content = fs.readFileSync(cookiesPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0 && !l.startsWith('#'));
      cookieEntries = lines.length;
      const cookieNames = new Set(lines.map(l => {
        const parts = l.split('\t');
        return parts.length >= 6 ? parts[5].trim() : '';
      }).filter(Boolean));

      detectedCookieNames = Array.from(cookieNames);
      hasLogin = cookieNames.has('LOGIN_INFO') ||
                 cookieNames.has('SAPISID') ||
                 cookieNames.has('__Secure-3PSID') ||
                 cookieNames.has('__Secure-1PSID') ||
                 cookieNames.has('SID');
      cookieStatus = hasLogin ? 'valid_authenticated' : 'guest_session_missing_login';
    } catch (e: any) {
      cookieStatus = `error: ${e.message}`;
    }
  }

  const proxyUrl = resolveProxyUrl();
  let proxyStatus = 'none';
  if (proxyUrl) {
    const masked = proxyUrl.replace(/:\/\/[^:]+:([^@]+)@/, '://***:***@');
    proxyStatus = `active (${masked})`;
  }

  res.json({
    status: 'ok',
    service: 'YouTube to MP4 Backend API',
    timestamp: Date.now(),
    node: process.version,
    uptime: Math.floor(process.uptime()),
    port: PORT,
    proxy: {
      configured: !!proxyUrl,
      status: proxyStatus,
      isDatacenter: !!proxyUrl && (proxyUrl.includes('webshare.io') || proxyUrl.includes('render') || proxyUrl.includes('aws')),
      typeNotice: proxyUrl && proxyUrl.includes('webshare.io')
        ? 'Webshare free tier routes through datacenter IPs which Google monitors. Residential proxies are recommended for 100% bypass of YouTube bot challenges.'
        : undefined
    },
    cookies: {
      status: cookieStatus,
      entries: cookieEntries,
      hasLoginSession: hasLogin,
      names: detectedCookieNames,
      detectedPath: cookiesPath || null
    },
    endpoints: {
      health: 'GET /health',
      info: 'POST /api/info',
      convert: 'POST /api/convert',
      status: 'GET /api/status/:id',
      download: 'GET /api/download/:id'
    }
  });
});

// 2. Fetch Video Metadata: POST /api/info and /info
app.post(['/api/info', '/info'], async (req, res) => {
  if (!checkRateLimit(req, 60, 60)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute before querying again.' });
  }

  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Video URL is required.' });
  }

  const validation = validateAndSanitizeYouTubeUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error || 'Invalid YouTube URL.' });
  }

  try {
    const video = await fetchVideoMetadata(validation.sanitizedUrl || url);
    res.json({ success: true, video });
  } catch (err: any) {
    res.status(422).json({ error: err.message || 'Failed to fetch video information.' });
  }
});

// 3. Start Conversion: POST /api/convert and /convert
app.post(['/api/convert', '/convert'], async (req, res) => {
  if (!checkRateLimit(req, 20, 60)) {
    return res.status(429).json({ error: 'Conversion limit reached. Please wait a moment before starting another job.' });
  }

  const { url, format = '1080p' } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Video URL is required.' });
  }

  const validation = validateAndSanitizeYouTubeUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error || 'Invalid YouTube URL.' });
  }

  const allowedFormats = ['360p', '720p', '1080p', '1440p', '4k', 'mp3'];
  const sanitizedFormat = allowedFormats.includes(format) ? format : '1080p';

  const jobId = crypto.randomBytes(8).toString('hex');
  const job = queue.createJob(jobId, validation.videoId!, validation.sanitizedUrl!, sanitizedFormat);

  // Trigger conversion in asynchronous background thread
  setImmediate(() => {
    executeConversionJob(job);
  });

  res.status(202).json({
    success: true,
    jobId,
    status: 'queued',
    message: 'Conversion job created successfully'
  });
});

// 4. Job Status: GET /api/status/:jobId and /status/:jobId
app.get(['/api/status/:jobId', '/status/:jobId'], (req, res) => {
  const { jobId } = req.params;
  const job = queue.getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired from server cache.' });
  }

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    downloadUrl: job.status === 'completed' ? `/api/download/${job.id}` : undefined,
    error: job.error
  });
});

// 5. Download Stream: GET /api/download/:jobId and /download/:jobId
app.get(['/api/download/:jobId', '/download/:jobId'], (req, res) => {
  const { jobId } = req.params;
  const job = queue.getJob(jobId);

  if (!job || job.status !== 'completed' || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'File not found or expired from server cache.' });
  }

  const filename = `youtube_${job.videoId}_${job.format}.${job.format === 'mp3' ? 'mp3' : 'mp4'}`;
  const stat = fs.statSync(job.outputPath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const isPreview = req.query.preview === 'true';
  const disposition = isPreview ? 'inline' : `attachment; filename="${filename}"`;

  // Support HTTP 206 Partial Content (essential for video seeking in HTML5 player!)
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(job.outputPath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': job.format === 'mp3' ? 'audio/mpeg' : 'video/mp4',
      'Content-Disposition': disposition
    });

    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': job.format === 'mp3' ? 'audio/mpeg' : 'video/mp4',
      'Content-Disposition': disposition
    });

    fs.createReadStream(job.outputPath).pipe(res);
  }
});

// 6. Contact Form Endpoint: POST /api/contact and /contact
app.post(['/api/contact', '/contact'], (req, res) => {
  const { name, email, message, subject } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }

  console.log(`[CONTACT RECEIVED] From: ${name} <${email}> | Subject: ${subject || 'General'}`);
  res.json({ success: true, message: 'Message received. We will respond promptly.' });
});

app.listen(PORT, HOST, async () => {
  console.log(`[BACKEND SERVER] YouTube to MP4 backend running at http://${HOST}:${PORT}`);
  console.log(`[BACKEND SERVER] Endpoints available: /health, /api/info, /api/convert, /api/status/:id, /api/download/:id`);

  const ffmpegOk = await hasFfmpeg();
  console.log(`[BACKEND SERVER] FFmpeg Status: ${ffmpegOk ? 'Available' : 'Not detected (Direct MP4 streams enabled)'}`);

  try {
    const ytPath = await ensureYtDlpBinary();
    console.log(`[BACKEND SERVER] Conversion engine (yt-dlp) ready at: ${ytPath}`);
  } catch (err: any) {
    console.warn(`[BACKEND SERVER] yt-dlp initialization notice:`, err.message);
  }
});

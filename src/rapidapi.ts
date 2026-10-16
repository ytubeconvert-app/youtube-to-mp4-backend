import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface RapidApiVideoInfo {
  id: string;
  title: string;
  author: string;
  duration: number;
  durationFormatted: string;
  thumbnail: string;
  formats: Array<{
    formatId: string;
    quality: string;
    label: string;
    filesize?: string;
    isAudioOnly?: boolean;
  }>;
}

export function isRapidApiConfigured(): boolean {
  const key = process.env.RAPIDAPI_KEY || process.env.X_RAPIDAPI_KEY;
  return !!key && key.trim().length > 10;
}

export function getRapidApiKey(): string {
  return (process.env.RAPIDAPI_KEY || process.env.X_RAPIDAPI_KEY || '').trim();
}

export function getRapidApiHost(): string {
  return (process.env.RAPIDAPI_HOST || 'youtube-info-download-api.p.rapidapi.com').trim();
}

// -------------------------------------------------------------------
// 1. Fetch Metadata via RapidAPI / oEmbed
// -------------------------------------------------------------------
export async function fetchRapidApiMetadata(videoId: string): Promise<RapidApiVideoInfo | null> {
  if (!isRapidApiConfigured()) return null;

  const apiKey = getRapidApiKey();
  const apiHost = getRapidApiHost();

  // Try yt-api metadata if host is yt-api
  if (apiHost.includes('yt-api')) {
    try {
      const url = `https://${apiHost}/dl?id=${videoId}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': apiHost
        }
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data && data.title) {
          const durationSec = parseInt(data.durationSeconds || data.duration || '0', 10) || 240;
          const m = Math.floor(durationSec / 60);
          const s = durationSec % 60;
          return {
            id: videoId,
            title: data.title,
            author: data.channelTitle || data.author || 'YouTube Creator',
            duration: durationSec,
            durationFormatted: `${m}:${s < 10 ? '0' : ''}${s}`,
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            formats: [
              { formatId: '1080p', quality: '1080p Full HD', label: '1080p (MP4)' },
              { formatId: '720p', quality: '720p HD', label: '720p (MP4)' },
              { formatId: '4k', quality: '4K Ultra HD', label: '4K (MP4)' },
              { formatId: '360p', quality: '360p Fast', label: '360p (MP4)' },
              { formatId: 'mp3', quality: 'Audio Only', label: 'MP3 Audio', isAudioOnly: true }
            ]
          };
        }
      }
    } catch {}
  }

  return null;
}

// -------------------------------------------------------------------
// 2. Helper: Download URL with Progress Reporting
// -------------------------------------------------------------------
async function streamUrlToFile(
  streamUrl: string,
  destPath: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  const res = await fetch(streamUrl);
  if (!res.ok) {
    throw new Error(`Stream download failed with HTTP ${res.status}: ${res.statusText}`);
  }

  const totalLength = parseInt(res.headers.get('content-length') || '0', 10);
  let downloaded = 0;

  const fileStream = fs.createWriteStream(destPath);

  if (res.body) {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        fileStream.write(value);
        downloaded += value.length;
        if (totalLength > 0 && onProgress) {
          const pct = Math.min(95, Math.floor((downloaded / totalLength) * 100));
          onProgress(pct);
        }
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end();
    fileStream.on('finish', () => resolve());
    fileStream.on('error', (err) => reject(err));
  });
}

// -------------------------------------------------------------------
// 3. Helper: FFmpeg Merge for Adaptive Streams
// -------------------------------------------------------------------
async function mergeVideoAndAudio(
  videoFile: string,
  audioFile: string,
  outputFile: string,
  ffmpegBin = 'ffmpeg'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoFile,
      '-i', audioFile,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-shortest',
      outputFile
    ];

    const child = spawn(ffmpegBin, args, { stdio: 'ignore' });
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        resolve();
      } else {
        reject(new Error(`FFmpeg merge failed with exit code ${code}`));
      }
    });
    child.on('error', (err) => reject(err));
  });
}

// -------------------------------------------------------------------
// 4. Provider A: youtube-info-download-api (Async Worker + Progress)
// -------------------------------------------------------------------
async function downloadViaYoutubeInfoDownloadApi(
  videoId: string,
  format: string,
  outputFilePath: string,
  apiKey: string,
  apiHost: string,
  onProgress?: (percent: number, message: string) => void
): Promise<boolean> {
  const fullVideoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  let formatParam = 'mp4';
  if (format === 'mp3') formatParam = 'mp3';
  else if (format === '1080p' || format === '1080') formatParam = '1080';
  else if (format === '720p' || format === '720') formatParam = '720';
  else if (format === '360p' || format === '360') formatParam = '360';
  else if (format === '4k' || format === '2160') formatParam = '4k';

  const downloadInitUrl = `https://${apiHost}/ajax/download.php?format=${formatParam}&url=${encodeURIComponent(fullVideoUrl)}`;
  console.log(`[RAPIDAPI] Initiating download on ${apiHost} for ${videoId} (${formatParam})...`);
  if (onProgress) onProgress(15, 'Requesting high-speed conversion from cloud API...');

  const initRes = await fetch(downloadInitUrl, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': apiHost
    }
  });

  if (!initRes.ok) {
    console.warn(`[RAPIDAPI] ${apiHost} returned HTTP ${initRes.status}`);
    return false;
  }

  const initData = (await initRes.json()) as any;
  if (!initData) return false;

  let directDownloadUrl = initData.download_url || initData.downloadUrl || initData.url;
  const progressUrl = initData.progress_url || initData.progressUrl;

  // Poll progress if asynchronous processing required
  if (!directDownloadUrl && progressUrl) {
    console.log(`[RAPIDAPI] Asynchronous conversion started. Polling progress...`);
    const maxPolls = 35; // 35 * 1.5s = ~52 seconds max
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 1500));

      try {
        const pollRes = await fetch(progressUrl, {
          headers: {
            'x-rapidapi-key': apiKey,
            'x-rapidapi-host': apiHost
          }
        });

        if (pollRes.ok) {
          const pollData = (await pollRes.json()) as any;
          const prog = pollData.progress || 0; // usually 0 to 1000
          const pct = Math.min(85, Math.max(15, Math.floor(prog / 10)));
          if (onProgress) onProgress(pct, `Converting in cloud: ${Math.min(100, Math.floor(prog / 10))}%`);

          if (pollData.download_url || pollData.downloadUrl || pollData.url) {
            directDownloadUrl = pollData.download_url || pollData.downloadUrl || pollData.url;
            console.log(`[RAPIDAPI] Conversion complete! Direct download stream ready.`);
            break;
          }

          if (pollData.success === 1 || pollData.success === true) {
            if (pollData.result?.download_url) directDownloadUrl = pollData.result.download_url;
            if (directDownloadUrl) break;
          }

          if (pollData.error || pollData.status === 'error') {
            console.warn(`[RAPIDAPI] Worker reported error:`, pollData.error || pollData.message);
            return false;
          }
        }
      } catch (pollErr: any) {
        console.warn(`[RAPIDAPI] Polling notice:`, pollErr.message);
      }
    }
  }

  if (!directDownloadUrl) {
    console.warn(`[RAPIDAPI] Could not retrieve download_url from ${apiHost}`);
    return false;
  }

  console.log(`[RAPIDAPI] Streaming converted media to disk...`);
  if (onProgress) onProgress(85, 'Downloading converted media file from cloud...');

  await streamUrlToFile(directDownloadUrl, outputFilePath, (pct) => {
    if (onProgress) onProgress(85 + Math.floor(pct * 0.14), `Downloading: ${pct}%`);
  });

  return fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 1000;
}

// -------------------------------------------------------------------
// 5. Provider B: yt-api (Direct Streams)
// -------------------------------------------------------------------
async function downloadViaYtApi(
  videoId: string,
  format: string,
  outputFilePath: string,
  apiKey: string,
  apiHost: string,
  ffmpegBin: string | null = null,
  onProgress?: (percent: number, message: string) => void
): Promise<boolean> {
  const url = `https://${apiHost}/dl?id=${videoId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': apiHost
    }
  });

  if (!res.ok) return false;
  const data = (await res.json()) as any;
  if (!data) return false;

  const formats: any[] = Array.isArray(data.formats) ? data.formats : [];
  const adaptive: any[] = Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats : [];

  if (format === 'mp3') {
    const audioStreams = adaptive.filter((f) => f.hasAudio && (!f.hasVideo || f.container === 'm4a' || f.container === 'mp3'));
    if (audioStreams.length > 0) {
      audioStreams.sort((a, b) => parseInt(b.bitrate || '0', 10) - parseInt(a.bitrate || '0', 10));
      const selected = audioStreams[0];
      if (selected.url) {
        if (onProgress) onProgress(25, 'Streaming audio from YouTube CDN...');
        await streamUrlToFile(selected.url, outputFilePath, (pct) => {
          if (onProgress) onProgress(25 + Math.floor(pct * 0.7), `Downloading: ${pct}%`);
        });
        return fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 1000;
      }
    }
  }

  let heightTarget = 1080;
  if (format === '720p') heightTarget = 720;
  if (format === '360p') heightTarget = 360;
  if (format === '4k') heightTarget = 2160;

  const combined = formats.filter((f) => f.hasVideo && f.hasAudio && f.url);
  if (combined.length > 0 && (heightTarget <= 720 || !ffmpegBin)) {
    combined.sort((a, b) => parseInt(b.qualityLabel || b.quality || '0', 10) - parseInt(a.qualityLabel || a.quality || '0', 10));
    const selected = combined[0];
    if (onProgress) onProgress(25, `Downloading ${selected.qualityLabel || 'MP4'} video...`);
    await streamUrlToFile(selected.url, outputFilePath, (pct) => {
      if (onProgress) onProgress(25 + Math.floor(pct * 0.7), `Downloading: ${pct}%`);
    });
    return fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 1000;
  }

  return false;
}

// -------------------------------------------------------------------
// 6. Master RapidAPI Entrypoint (Auto-Detects Host)
// -------------------------------------------------------------------
export async function downloadViaRapidApi(
  videoId: string,
  format: string,
  outputFilePath: string,
  ffmpegBin: string | null = null,
  onProgress?: (percent: number, message: string) => void
): Promise<boolean> {
  if (!isRapidApiConfigured()) return false;

  const apiKey = getRapidApiKey();
  const apiHost = getRapidApiHost();

  console.log(`[RAPIDAPI] Starting cloud extraction for ${videoId} (${format}) via ${apiHost}...`);

  try {
    // 1. Check if user configured youtube-info-download-api
    if (apiHost.includes('youtube-info-download-api')) {
      return await downloadViaYoutubeInfoDownloadApi(videoId, format, outputFilePath, apiKey, apiHost, onProgress);
    }

    // 2. Check if user configured yt-api
    if (apiHost.includes('yt-api')) {
      return await downloadViaYtApi(videoId, format, outputFilePath, apiKey, apiHost, ffmpegBin, onProgress);
    }

    // 3. Fallback: Try youtube-info-download-api format first, then yt-api format
    const successA = await downloadViaYoutubeInfoDownloadApi(videoId, format, outputFilePath, apiKey, apiHost, onProgress);
    if (successA) return true;

    return await downloadViaYtApi(videoId, format, outputFilePath, apiKey, apiHost, ffmpegBin, onProgress);
  } catch (err: any) {
    console.error(`[RAPIDAPI] Critical execution error:`, err.message);
    return false;
  }
}

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
  return (process.env.RAPIDAPI_HOST || 'yt-api.p.rapidapi.com').trim();
}

// -------------------------------------------------------------------
// 1. Fetch Metadata via RapidAPI
// -------------------------------------------------------------------
export async function fetchRapidApiMetadata(videoId: string): Promise<RapidApiVideoInfo | null> {
  if (!isRapidApiConfigured()) return null;

  const apiKey = getRapidApiKey();
  const apiHost = getRapidApiHost();

  try {
    const url = `https://${apiHost}/dl?id=${videoId}`;
    console.log(`[RAPIDAPI] Fetching metadata for ${videoId} from ${apiHost}...`);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': apiHost
      }
    });

    if (!res.ok) {
      console.warn(`[RAPIDAPI] Metadata request returned HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as any;
    if (!data) return null;

    const title = data.title || `YouTube Video (${videoId})`;
    const author = data.channelTitle || data.author || 'YouTube Creator';
    const durationSec = parseInt(data.durationSeconds || data.duration || '0', 10) || 240;

    const m = Math.floor(durationSec / 60);
    const s = durationSec % 60;
    const durationFormatted = `${m}:${s < 10 ? '0' : ''}${s}`;

    let thumbUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    if (Array.isArray(data.thumbnail) && data.thumbnail.length > 0) {
      thumbUrl = data.thumbnail[data.thumbnail.length - 1].url || thumbUrl;
    } else if (typeof data.thumbnail === 'string') {
      thumbUrl = data.thumbnail;
    }

    return {
      id: videoId,
      title,
      author,
      duration: durationSec,
      durationFormatted,
      thumbnail: thumbUrl,
      formats: [
        { formatId: '1080p', quality: '1080p Full HD', label: '1080p (MP4)' },
        { formatId: '720p', quality: '720p HD', label: '720p (MP4)' },
        { formatId: '4k', quality: '4K Ultra HD', label: '4K (MP4)' },
        { formatId: '360p', quality: '360p Fast', label: '360p (MP4)' },
        { formatId: 'mp3', quality: 'Audio Only', label: 'MP3 Audio', isAudioOnly: true }
      ]
    };
  } catch (err: any) {
    console.warn(`[RAPIDAPI] Metadata fetch error:`, err.message);
    return null;
  }
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
// 3. Helper: FFmpeg Merge for 1080p/4K Video + Audio
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
// 4. Core Downloader via RapidAPI
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

  console.log(`[RAPIDAPI] Initiating download job for ${videoId} (${format}) via ${apiHost}...`);
  if (onProgress) onProgress(15, 'Requesting high-speed stream from cloud API...');

  try {
    // 1. Query stream endpoint
    const url = `https://${apiHost}/dl?id=${videoId}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': apiHost
      }
    });

    if (!res.ok) {
      console.warn(`[RAPIDAPI] Download request returned HTTP ${res.status}`);
      return false;
    }

    const data = (await res.json()) as any;
    if (!data) return false;

    // Direct pre-built link from generic converters (e.g. downloadUrl, link, mp3_url)
    const genericLink = data.downloadUrl || data.download_url || data.link || data.url || data.mp3_url;
    if (typeof genericLink === 'string' && genericLink.startsWith('http')) {
      console.log(`[RAPIDAPI] Found direct stream link from generic provider.`);
      if (onProgress) onProgress(30, 'Downloading media stream from cloud cache...');
      await streamUrlToFile(genericLink, outputFilePath, (pct) => {
        if (onProgress) onProgress(30 + Math.floor(pct * 0.65), `Downloading: ${pct}%`);
      });
      return fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 1000;
    }

    const formats: any[] = Array.isArray(data.formats) ? data.formats : [];
    const adaptive: any[] = Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats : [];

    // CASE A: MP3 Audio Only
    if (format === 'mp3') {
      let audioStreamUrl: string | null = null;

      // 1. Check adaptive formats for high quality audio
      const audioStreams = adaptive.filter((f) => f.hasAudio && (!f.hasVideo || f.container === 'm4a' || f.container === 'mp3'));
      if (audioStreams.length > 0) {
        // Pick highest bitrate audio
        audioStreams.sort((a, b) => (parseInt(b.bitrate || '0', 10) - parseInt(a.bitrate || '0', 10)));
        audioStreamUrl = audioStreams[0].url;
      }

      // 2. Fallback to formats with audio
      if (!audioStreamUrl && formats.length > 0) {
        const withAudio = formats.filter((f) => f.hasAudio && f.url);
        if (withAudio.length > 0) audioStreamUrl = withAudio[0].url;
      }

      if (!audioStreamUrl) {
        console.warn('[RAPIDAPI] No audio stream found in API payload.');
        return false;
      }

      if (onProgress) onProgress(25, 'Streaming pristine audio track from YouTube CDN...');
      await streamUrlToFile(audioStreamUrl, outputFilePath, (pct) => {
        if (onProgress) onProgress(25 + Math.floor(pct * 0.7), `Downloading: ${pct}%`);
      });

      return fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 1000;
    }

    // CASE B: Video Formats (720p, 360p, 1080p, 4k)
    let heightTarget = 1080;
    if (format === '720p') heightTarget = 720;
    if (format === '360p') heightTarget = 360;
    if (format === '4k') heightTarget = 2160;

    // 1. Look for pre-muxed combined stream (video + audio in single file, common for 720p and 360p)
    const combinedMatches = formats.filter((f) => {
      const h = parseInt(f.qualityLabel || f.quality || '0', 10);
      return f.hasVideo && f.hasAudio && f.url && (h <= heightTarget || heightTarget === 1080);
    });

    if (combinedMatches.length > 0 && (heightTarget <= 720 || !ffmpegBin)) {
      // Sort to best resolution
      combinedMatches.sort((a, b) => {
        const ha = parseInt(a.qualityLabel || a.quality || '0', 10);
        const hb = parseInt(b.qualityLabel || b.quality || '0', 10);
        return hb - ha;
      });

      const selected = combinedMatches[0];
      console.log(`[RAPIDAPI] Downloading pre-muxed ${selected.qualityLabel || selected.quality} stream...`);
      if (onProgress) onProgress(25, `Downloading ${selected.qualityLabel || 'MP4'} video stream...`);

      await streamUrlToFile(selected.url, outputFilePath, (pct) => {
        if (onProgress) onProgress(25 + Math.floor(pct * 0.7), `Downloading: ${pct}%`);
      });

      return fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 1000;
    }

    // 2. Look for High-Definition Adaptive Streams (1080p, 4K)
    const videoMatches = adaptive.filter((f) => {
      const h = parseInt(f.qualityLabel || f.quality || '0', 10);
      return f.hasVideo && f.url && (heightTarget === 2160 ? h >= 1080 : h <= heightTarget);
    });

    if (videoMatches.length > 0 && ffmpegBin) {
      videoMatches.sort((a, b) => {
        const ha = parseInt(a.qualityLabel || a.quality || '0', 10);
        const hb = parseInt(b.qualityLabel || b.quality || '0', 10);
        return hb - ha;
      });

      const videoStream = videoMatches[0];
      const audioStreams = adaptive.filter((f) => f.hasAudio && f.url);
      const audioStream = audioStreams.length > 0 ? audioStreams[0] : null;

      if (videoStream && audioStream) {
        console.log(`[RAPIDAPI] Downloading adaptive 1080p/4K stream + audio for merging...`);
        const tempDir = path.dirname(outputFilePath);
        const tempVideo = path.join(tempDir, `temp_vid_${path.basename(outputFilePath)}`);
        const tempAudio = path.join(tempDir, `temp_aud_${path.basename(outputFilePath)}.m4a`);

        try {
          if (onProgress) onProgress(20, 'Downloading HD video stream...');
          await streamUrlToFile(videoStream.url, tempVideo, (pct) => {
            if (onProgress) onProgress(20 + Math.floor(pct * 0.4), `Downloading video: ${pct}%`);
          });

          if (onProgress) onProgress(65, 'Downloading audio track...');
          await streamUrlToFile(audioStream.url, tempAudio, (pct) => {
            if (onProgress) onProgress(65 + Math.floor(pct * 0.2), `Downloading audio: ${pct}%`);
          });

          if (onProgress) onProgress(88, 'Merging Full HD video and audio...');
          await mergeVideoAndAudio(tempVideo, tempAudio, outputFilePath, ffmpegBin);

          return fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 1000;
        } finally {
          try { if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo); } catch {}
          try { if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio); } catch {}
        }
      }
    }

    // Fallback: If no adaptive stream could be merged, download best available combined stream
    if (combinedMatches.length > 0) {
      const selected = combinedMatches[0];
      console.log(`[RAPIDAPI] Fallback to best combined stream: ${selected.qualityLabel}`);
      if (onProgress) onProgress(25, `Downloading ${selected.qualityLabel || 'MP4'} video...`);

      await streamUrlToFile(selected.url, outputFilePath, (pct) => {
        if (onProgress) onProgress(25 + Math.floor(pct * 0.7), `Downloading: ${pct}%`);
      });

      return fs.existsSync(outputFilePath) && fs.statSync(outputFilePath).size > 1000;
    }

    console.warn('[RAPIDAPI] Could not match appropriate stream in response.');
    return false;
  } catch (err: any) {
    console.error('[RAPIDAPI] Execution error:', err.message);
    return false;
  }
}

// Cloudflare Worker for YouTube to MP4 Backend API via RapidAPI
// Eliminates the need for local yt-dlp, FFmpeg binaries, and heavy Linux/Docker hosts.

export interface Env {
  RAPIDAPI_KEY?: string;
  X_RAPIDAPI_KEY?: string;
  RAPIDAPI_HOST?: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Backend-Signature, Range, X-Requested-With',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition',
  'Access-Control-Max-Age': '86400'
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}

function extractYouTubeId(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  const regex = /(?:youtu\.be\/|(?:www\.|m\.|music\.)?youtube\.com\/(?:embed\/|v\/|e\/|shorts\/|live\/|watch\?v=|watch\?.+&v=))([a-zA-Z0-9_-]{11})/i;
  const match = trimmed.match(regex);
  if (match && match[1]) return match[1];

  try {
    const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    if (parsed.searchParams.has('v')) {
      const v = parsed.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    }
    if (parsed.hostname.includes('youtu.be')) {
      const id = parsed.pathname.slice(1).split('/')[0];
      if (id && id.length === 11) return id;
    }
  } catch {}

  return null;
}

function encodeToken(obj: Record<string, any>): string {
  try {
    const json = JSON.stringify(obj);
    return btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch {
    return btoa(JSON.stringify(obj));
  }
}

function decodeToken(token: string): Record<string, any> | null {
  try {
    let str = token.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const json = decodeURIComponent(escape(atob(str)));
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(atob(token));
    } catch {
      return null;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // 1. Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    const apiKey = (env.RAPIDAPI_KEY || env.X_RAPIDAPI_KEY || '').trim();
    const apiHost = (env.RAPIDAPI_HOST || 'youtube-info-download-api.p.rapidapi.com').trim();

    // 2. Health & Root Info
    if (path === '' || path === '/' || path === '/health' || path === '/api' || path === '/api/health') {
      return jsonResponse({
        status: 'ok',
        service: 'YouTube to MP4 Cloudflare Worker Backend',
        timestamp: Date.now(),
        edge: true,
        rapidApi: {
          configured: !!apiKey,
          host: apiHost
        },
        endpoints: {
          health: 'GET /health',
          info: 'POST /api/info',
          convert: 'POST /api/convert',
          status: 'GET /api/status/:id',
          download: 'GET /api/download/:id'
        }
      });
    }

    // 3. Fetch Video Metadata (POST /api/info or /info)
    if (request.method === 'POST' && (path === '/api/info' || path === '/info')) {
      try {
        const body: any = await request.json().catch(() => ({}));
        const rawUrl = body.url || body.videoId;
        if (!rawUrl) {
          return jsonResponse({ error: 'Video URL or videoId is required.' }, 400);
        }

        const videoId = extractYouTubeId(rawUrl);
        if (!videoId) {
          return jsonResponse({ error: 'Invalid YouTube video URL.' }, 400);
        }

        let title = `YouTube Video (${videoId})`;
        let author = 'YouTube Creator';
        let duration = 240;
        let durationFormatted = 'HD Stream';

        // Attempt 1: Fetch via RapidAPI if using yt-api
        if (apiKey && apiHost.includes('yt-api')) {
          try {
            const rapidRes = await fetch(`https://${apiHost}/dl?id=${videoId}`, {
              headers: {
                'x-rapidapi-key': apiKey,
                'x-rapidapi-host': apiHost
              }
            });
            if (rapidRes.ok) {
              const data: any = await rapidRes.json();
              if (data && data.title) {
                title = data.title;
                author = data.channelTitle || data.author || author;
                const sec = parseInt(data.durationSeconds || data.duration || '0', 10);
                if (sec > 0) {
                  duration = sec;
                  const m = Math.floor(sec / 60);
                  const s = sec % 60;
                  durationFormatted = `${m}:${s < 10 ? '0' : ''}${s}`;
                }
              }
            }
          } catch {}
        }

        // Attempt 2: YouTube official public oEmbed (Always available, zero bot block)
        if (title.startsWith('YouTube Video')) {
          try {
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            const oembedRes = await fetch(oembedUrl);
            if (oembedRes.ok) {
              const oembed: any = await oembedRes.json();
              if (oembed.title) title = oembed.title;
              if (oembed.author_name) author = oembed.author_name;
            }
          } catch {}
        }

        return jsonResponse({
          success: true,
          video: {
            id: videoId,
            title,
            author,
            duration,
            durationFormatted,
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            formats: [
              { formatId: '1080p', quality: '1080p Full HD', label: '1080p (MP4)' },
              { formatId: '720p', quality: '720p HD', label: '720p (MP4)' },
              { formatId: '4k', quality: '4K Ultra HD', label: '4K (MP4)' },
              { formatId: '360p', quality: '360p Fast', label: '360p (MP4)' },
              { formatId: 'mp3', quality: 'Audio Only', label: 'MP3 Audio', isAudioOnly: true }
            ]
          }
        });
      } catch (err: any) {
        return jsonResponse({ error: err.message || 'Failed to fetch video information.' }, 500);
      }
    }

    // 4. Start Conversion (POST /api/convert or /convert)
    if (request.method === 'POST' && (path === '/api/convert' || path === '/convert')) {
      try {
        const body: any = await request.json().catch(() => ({}));
        const rawUrl = body.url || body.videoId;
        const requestedFormat = (body.format || '1080p').toLowerCase();

        if (!rawUrl) {
          return jsonResponse({ error: 'Video URL is required.' }, 400);
        }

        const videoId = extractYouTubeId(rawUrl);
        if (!videoId) {
          return jsonResponse({ error: 'Invalid YouTube video URL.' }, 400);
        }

        if (!apiKey) {
          return jsonResponse({
            error: 'RapidAPI key is not configured. Please add RAPIDAPI_KEY in Cloudflare Worker environment variables.'
          }, 503);
        }

        const fullVideoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        // Provider A: youtube-info-download-api (Official RapidAPI Provider)
        if (apiHost.includes('youtube-info-download-api')) {
          let formatParam = 'mp4';
          if (requestedFormat === 'mp3') formatParam = 'mp3';
          else if (requestedFormat === '1080p' || requestedFormat === '1080') formatParam = '1080';
          else if (requestedFormat === '720p' || requestedFormat === '720') formatParam = '720';
          else if (requestedFormat === '360p' || requestedFormat === '360') formatParam = '360';
          else if (requestedFormat === '4k' || requestedFormat === '2160') formatParam = '4k';

          const initUrl = `https://${apiHost}/ajax/download.php?format=${formatParam}&url=${encodeURIComponent(fullVideoUrl)}`;
          const initRes = await fetch(initUrl, {
            headers: {
              'x-rapidapi-key': apiKey,
              'x-rapidapi-host': apiHost
            }
          });

          if (!initRes.ok) {
            return jsonResponse({ error: `RapidAPI returned status ${initRes.status}` }, 502);
          }

          const initData: any = await initRes.json();
          const directUrl = initData.download_url || initData.downloadUrl || initData.url;
          const progressUrl = initData.progress_url || initData.progressUrl;

          if (directUrl) {
            const jobId = encodeToken({ d: directUrl, v: videoId, f: requestedFormat, s: 'completed' });
            return jsonResponse({
              success: true,
              jobId,
              status: 'completed',
              progress: 100,
              message: 'Conversion completed successfully!',
              downloadUrl: `/api/download/${jobId}`
            }, 200);
          }

          if (progressUrl) {
            const jobId = encodeToken({ p: progressUrl, v: videoId, f: requestedFormat, s: 'processing' });
            return jsonResponse({
              success: true,
              jobId,
              status: 'processing',
              progress: 20,
              message: 'Converting video in cloud...'
            }, 202);
          }

          return jsonResponse({ error: 'Unexpected response from cloud conversion provider.' }, 502);
        }

        // Provider B: yt-api
        if (apiHost.includes('yt-api')) {
          const ytRes = await fetch(`https://${apiHost}/dl?id=${videoId}`, {
            headers: {
              'x-rapidapi-key': apiKey,
              'x-rapidapi-host': apiHost
            }
          });

          if (!ytRes.ok) {
            return jsonResponse({ error: `RapidAPI error status ${ytRes.status}` }, 502);
          }

          const data: any = await ytRes.json();
          const formats: any[] = Array.isArray(data.formats) ? data.formats : [];
          const adaptive: any[] = Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats : [];

          let streamUrl: string | null = null;
          if (requestedFormat === 'mp3') {
            const audio = adaptive.filter(f => f.hasAudio && (!f.hasVideo || f.container === 'm4a' || f.container === 'mp3'));
            audio.sort((a, b) => parseInt(b.bitrate || '0', 10) - parseInt(a.bitrate || '0', 10));
            streamUrl = audio[0]?.url || null;
          } else {
            const combined = formats.filter(f => f.hasVideo && f.hasAudio && f.url);
            combined.sort((a, b) => parseInt(b.qualityLabel || '0', 10) - parseInt(a.qualityLabel || '0', 10));
            streamUrl = combined[0]?.url || null;
          }

          if (streamUrl) {
            const jobId = encodeToken({ d: streamUrl, v: videoId, f: requestedFormat, s: 'completed' });
            return jsonResponse({
              success: true,
              jobId,
              status: 'completed',
              progress: 100,
              message: 'Conversion completed successfully!',
              downloadUrl: `/api/download/${jobId}`
            });
          }

          return jsonResponse({ error: 'Selected video stream not directly extractable.' }, 422);
        }

        return jsonResponse({ error: `Unsupported RAPIDAPI_HOST: ${apiHost}` }, 500);
      } catch (err: any) {
        return jsonResponse({ error: err.message || 'Conversion request failed.' }, 500);
      }
    }

    // 5. Job Status Check (GET /api/status/:id or /status/:id)
    if (request.method === 'GET' && (path.startsWith('/api/status/') || path.startsWith('/status/'))) {
      const jobId = path.replace(/^\/(?:api\/)?status\//, '');
      const state = decodeToken(jobId);

      if (!state) {
        return jsonResponse({ error: 'Invalid or expired job identifier.' }, 404);
      }

      // If already has direct download URL
      if (state.d) {
        return jsonResponse({
          jobId,
          status: 'completed',
          progress: 100,
          downloadUrl: `/api/download/${jobId}`
        });
      }

      // Poll progress URL from RapidAPI
      if (state.p) {
        try {
          const pollRes = await fetch(state.p, {
            headers: {
              'x-rapidapi-key': apiKey,
              'x-rapidapi-host': apiHost
            }
          });

          if (pollRes.ok) {
            const pollData: any = await pollRes.json();
            const directUrl = pollData.download_url || pollData.downloadUrl || pollData.url || pollData.result?.download_url;

            if (directUrl) {
              const newJobId = encodeToken({ d: directUrl, v: state.v, f: state.f, s: 'completed' });
              return jsonResponse({
                jobId: newJobId,
                status: 'completed',
                progress: 100,
                message: 'Video ready!',
                downloadUrl: `/api/download/${newJobId}`
              });
            }

            if (pollData.error || pollData.status === 'error') {
              return jsonResponse({
                jobId,
                status: 'failed',
                error: pollData.error || pollData.message || 'Cloud conversion failed.'
              });
            }

            const rawProg = parseInt(pollData.progress || '0', 10);
            const normalizedProg = Math.min(95, Math.max(25, Math.floor(rawProg / 10)));

            return jsonResponse({
              jobId,
              status: 'processing',
              progress: normalizedProg,
              message: `Converting in cloud: ${normalizedProg}%`
            });
          }
        } catch (pollErr: any) {
          return jsonResponse({
            jobId,
            status: 'processing',
            progress: 50,
            message: 'Conversion in progress...'
          });
        }
      }

      return jsonResponse({ jobId, status: 'failed', error: 'Job status unavailable.' }, 500);
    }

    // 6. Direct Download Stream or Redirect (GET /api/download/:id or /download/:id)
    if (request.method === 'GET' && (path.startsWith('/api/download/') || path.startsWith('/download/'))) {
      const jobId = path.replace(/^\/(?:api\/)?download\//, '');
      const state = decodeToken(jobId);

      if (!state || !state.d) {
        return new Response('File not found or link expired.', {
          status: 404,
          headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS }
        });
      }

      const directDownloadUrl = state.d;

      // 302 Redirect directly to RapidAPI CDN stream for maximum download speed and zero worker memory usage
      return Response.redirect(directDownloadUrl, 302);
    }

    // 404 Fallback
    return jsonResponse({ error: 'Endpoint not found.' }, 404);
  }
};

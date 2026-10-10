// Strict YouTube URL Sanitizer & Video ID Extractor
export interface ValidationResult {
  valid: boolean;
  videoId?: string;
  sanitizedUrl?: string;
  error?: string;
}

export function validateAndSanitizeYouTubeUrl(rawUrl: string): ValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'URL must be a non-empty string.' };
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return { valid: false, error: 'Malformed URL structure.' };
  }

  // Strict hostname allow-list (blocks SSRF, localhost, private IPs, external hosts)
  const allowedHosts = [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be',
    'music.youtube.com'
  ];

  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    return {
      valid: false,
      error: 'Invalid host. Only youtube.com, m.youtube.com, and youtu.be URLs are accepted.'
    };
  }

  let videoId: string | null = null;

  if (host === 'youtu.be') {
    // Path is /<id>
    const pathPart = parsed.pathname.slice(1).split('/')[0];
    videoId = pathPart || null;
  } else {
    // youtube.com
    if (parsed.pathname === '/watch') {
      videoId = parsed.searchParams.get('v');
    } else if (parsed.pathname.startsWith('/shorts/')) {
      videoId = parsed.pathname.split('/shorts/')[1]?.split('/')[0] || null;
    } else if (parsed.pathname.startsWith('/embed/')) {
      videoId = parsed.pathname.split('/embed/')[1]?.split('/')[0] || null;
    }
  }

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return {
      valid: false,
      error: 'Could not extract valid 11-character YouTube video ID.'
    };
  }

  // Reconstruct completely clean canonical URL to prevent injection/SSRF
  const sanitizedUrl = `https://www.youtube.com/watch?v=${videoId}`;
  return { valid: true, videoId, sanitizedUrl };
}

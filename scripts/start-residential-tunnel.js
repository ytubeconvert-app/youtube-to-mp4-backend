import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');
const binDir = path.join(backendDir, 'bin');
const cloudflaredExe = path.join(binDir, 'cloudflared.exe');

if (!fs.existsSync(cloudflaredExe)) {
  console.error('[ERROR] cloudflared.exe not found in bin/ folder. Please run setup first.');
  process.exit(1);
}

console.log('================================================================');
console.log('  STARTING LOCAL RESIDENTIAL BACKEND & CLOUDFLARE TUNNEL');
console.log('================================================================\n');

// 1. Ensure build exists
const serverJs = path.join(backendDir, 'dist', 'server.js');
if (!fs.existsSync(serverJs)) {
  console.log('[BUILD] dist/server.js not found. Compiling TypeScript...');
  const tsc = spawn('npx', ['tsc'], { cwd: backendDir, stdio: 'inherit', shell: true });
  await new Promise((resolve) => tsc.on('close', resolve));
}

// 2. Start local backend server on port 8787
console.log('[SERVER] Launching local converter engine on port 8787...');
const serverProcess = spawn('node', ['dist/server.js'], {
  cwd: backendDir,
  env: {
    ...process.env,
    PORT: '8787',
    HOST: '127.0.0.1',
    NODE_ENV: 'development'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

serverProcess.stdout?.on('data', (data) => {
  const msg = data.toString();
  if (msg.includes('[BACKEND SERVER]') || msg.includes('ready') || msg.includes('JOB')) {
    process.stdout.write(`  [Local Backend] ${msg}`);
  }
});

serverProcess.stderr?.on('data', (data) => {
  process.stderr.write(`  [Local Backend Err] ${data.toString()}`);
});

// 3. Start Cloudflare Quick Tunnel
console.log('[TUNNEL] Connecting to Cloudflare edge network via Quick Tunnel...');
const tunnelProcess = spawn(cloudflaredExe, ['tunnel', '--url', 'http://127.0.0.1:8787'], {
  cwd: backendDir,
  stdio: ['ignore', 'pipe', 'pipe']
});

let tunnelUrlFound = false;

function scanForTunnelUrl(chunk) {
  const str = chunk.toString();
  const match = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  if (match && !tunnelUrlFound) {
    tunnelUrlFound = true;
    const url = match[0];
    
    // Save to file for easy copy/paste or scripts
    fs.writeFileSync(path.join(backendDir, 'tunnel-url.txt'), url, 'utf8');

    console.log('\n================================================================');
    console.log('  SUCCESS! RESIDENTIAL TUNNEL IS ONLINE AND ACTIVE');
    console.log('================================================================');
    console.log(`\n  Public Tunnel URL:  ${url}`);
    console.log(`  Local Health Check: http://127.0.0.1:8787/health\n`);
    console.log('  HOW TO USE THIS TUNNEL:');
    console.log('  --------------------------------------------------------------');
    console.log('  Option A (Direct Frontend Use):');
    console.log(`    Set PUBLIC_API_URL=${url} in your frontend.`);
    console.log('\n  Option B (Bridge Render to this Residential Machine):');
    console.log('    In your Render Dashboard (youtube-to-mp4-backend):');
    console.log(`    Add/Update Environment Variable:`);
    console.log(`      RESIDENTIAL_TUNNEL_URL = ${url}`);
    console.log('    Your website on Render will automatically delegate YouTube');
    console.log('    downloads to this residential IP, bypassing all bot checks!');
    console.log('================================================================\n');
    console.log('Press Ctrl+C to stop the tunnel and local backend at any time.\n');
  }
}

tunnelProcess.stdout?.on('data', scanForTunnelUrl);
tunnelProcess.stderr?.on('data', scanForTunnelUrl);

tunnelProcess.on('close', (code) => {
  console.log(`[TUNNEL] Cloudflare tunnel exited with code ${code}`);
  cleanup();
});

serverProcess.on('close', (code) => {
  console.log(`[SERVER] Local backend exited with code ${code}`);
  cleanup();
});

function cleanup() {
  try {
    tunnelProcess.kill();
  } catch {}
  try {
    serverProcess.kill();
  } catch {}
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

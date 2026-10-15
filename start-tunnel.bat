@echo off
title YouTube to MP4 - Residential Cloudflare Tunnel
cd /d "%~dp0"

echo ================================================================
echo   Checking Dependencies & Starting Residential Tunnel
echo ================================================================

node scripts/start-residential-tunnel.js
pause

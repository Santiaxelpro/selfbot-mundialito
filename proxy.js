require('dotenv').config();
const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { spawn } = require('child_process');
const { URL } = require('url');
const { PassThrough } = require('stream');

const PORT = process.env.PORT || 25553;
const TARGET_PAGE = process.env.PROXY_TARGET_URL || 'https://tvtvhd.com/tv/canales.php?stream=dsports';
const MANIFEST_REFRESH_SEC = 10;
const TOKEN_RENEW_SEC = 300;

let m3u8Url = null;
let manifestContent = null;
let originBaseUrl = null;
let lastTokenRenew = 0;
let isRenewing = false;
let activeFFmpeg = null;
let globalStream = new PassThrough();
let streamClients = 0;

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://tvtvhd.com/',
    'Origin': 'https://tvtvhd.com',
    'Accept': '*/*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Connection': 'keep-alive'
};

async function renewToken() {
    if (isRenewing) return;
    isRenewing = true;
    console.log('🔄 Renovando token...');
    let browser = null;
    try {
        const executablePath = await chromium.executablePath();
        browser = await puppeteer.launch({
            executablePath,
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
            headless: chromium.headless,
            defaultViewport: chromium.defaultViewport,
        });
        const page = await browser.newPage();
        let capturedUrl = null;
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (url.includes('.m3u8') && !capturedUrl) {
                capturedUrl = url;
                console.log(`✅ M3U8 capturado: ${url}`);
            }
            req.continue();
        });
        await page.goto(TARGET_PAGE, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (!capturedUrl) {
            capturedUrl = await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video?.src?.includes('.m3u8')) return video.src;
                const source = document.querySelector('source[src*=".m3u8"]');
                if (source?.src) return source.src;
                const scripts = Array.from(document.querySelectorAll('script'));
                for (let script of scripts) {
                    const match = script.textContent?.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
                    if (match) return match[0];
                }
                return null;
            });
        }
        if (capturedUrl) {
            m3u8Url = capturedUrl;
            lastTokenRenew = Date.now();
            await fetchAndRewriteManifest();
            restartFFmpeg();
        } else {
            console.error('❌ No se pudo obtener URL del M3U8');
        }
    } catch (error) {
        console.error('❌ Error renovando token:', error.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        isRenewing = false;
    }
}

async function fetchAndRewriteManifest() {
    if (!m3u8Url) { await renewToken(); return; }
    try {
        const response = await axios.get(m3u8Url, { timeout: 15000, responseType: 'text', headers: REQUEST_HEADERS });
        if (response.status === 403) { console.log('⚠️ Token expirado'); await renewToken(); return; }
        if (response.status !== 200) throw new Error(`Status ${response.status}`);
        const rawContent = response.data;
        const parsed = new URL(m3u8Url);
        originBaseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname.substring(0, parsed.pathname.lastIndexOf('/') + 1)}`;
        const lines = rawContent.split('\n');
        const rewritten = lines.map(line => {
            if (line.trim() && !line.startsWith('#') && line.includes('.ts')) {
                let absoluteUrl = new URL(line, originBaseUrl).href;
                return `/segment?url=${encodeURIComponent(absoluteUrl)}`;
            }
            return line;
        });
        manifestContent = rewritten.join('\n');
        console.log(`✅ Manifiesto actualizado (${rewritten.filter(l => l.startsWith('/segment')).length} segmentos)`);
    } catch (error) {
        console.error('❌ Error al obtener manifiesto:', error.message);
        if (error.response?.status === 403) await renewToken();
    }
}

function startFFmpeg() {
    if (activeFFmpeg) {
        activeFFmpeg.kill('SIGTERM');
        activeFFmpeg = null;
    }
    if (!m3u8Url) {
        console.log('⏳ Esperando token...');
        setTimeout(() => startFFmpeg(), 2000);
        return;
    }
    console.log('🎥 Iniciando FFmpeg...');
    const ffmpeg = spawn('ffmpeg', [
        '-re',
        '-stream_loop', '-1',
        '-i', m3u8Url,
        '-c:v', 'libx264',
        '-profile:v', 'baseline',
        '-level', '3.0',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', '1000k',
        '-maxrate', '1200k',
        '-bufsize', '2000k',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-f', 'mpegts',
        '-mpegts_flags', 'resend_headers+system_b',
        '-muxdelay', '0',
        '-flush_packets', '1',
        '-fflags', 'nobuffer+discardcorrupt',
        '-flags', 'low_delay',
        'pipe:1'
    ]);
    ffmpeg.stderr.on('data', (data) => console.error(`FFmpeg: ${data.toString().trim()}`));
    ffmpeg.on('close', (code) => {
        console.log(`FFmpeg closed with code ${code}`);
        activeFFmpeg = null;
        // Reiniciar si hay clientes
        if (streamClients > 0) startFFmpeg();
    });
    // Conectar al stream global sin cerrarlo al final
    ffmpeg.stdout.pipe(globalStream, { end: false });
    activeFFmpeg = ffmpeg;
}

function restartFFmpeg() {
    if (activeFFmpeg) {
        activeFFmpeg.kill('SIGTERM');
        activeFFmpeg = null;
    }
    if (streamClients > 0) setTimeout(() => startFFmpeg(), 1000);
}

const app = express();

app.get('/manifest', (req, res) => {
    if (!manifestContent) return res.status(503).send('No disponible');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(manifestContent);
});

app.get('/segment', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Falta url');
    try {
        const response = await axios({ method: 'get', url: targetUrl, responseType: 'stream', timeout: 30000, headers: REQUEST_HEADERS });
        res.set('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'no-cache');
        response.data.pipe(res);
    } catch (error) {
        console.error(`❌ Error al servir segmento: ${error.message}`);
        if (!res.headersSent) res.status(500).send('Error');
    }
});

app.get('/stream', (req, res) => {
    if (!m3u8Url) return res.status(503).send('Token no disponible');
    res.set({
        'Content-Type': 'video/MP2T',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'Connection': 'keep-alive'
    });
    streamClients++;
    console.log(`📡 Cliente conectado (${streamClients} totales)`);
    if (!activeFFmpeg) startFFmpeg();
    // Cada cliente obtiene su propio PassThrough para no afectar a otros
    const clientStream = new PassThrough();
    globalStream.pipe(clientStream, { end: false });
    clientStream.pipe(res, { end: true });
    req.on('close', () => {
        streamClients--;
        console.log(`📡 Cliente desconectado (${streamClients} restantes)`);
        clientStream.unpipe(res);
        clientStream.destroy();
        if (streamClients === 0 && activeFFmpeg) {
            console.log('⏹️ Sin clientes, deteniendo FFmpeg...');
            activeFFmpeg.kill('SIGTERM');
            activeFFmpeg = null;
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: manifestContent ? 'ok' : 'initializing',
        hasToken: !!m3u8Url,
        clients: streamClients,
        ffmpegRunning: !!activeFFmpeg
    });
});

async function start() {
    console.log('🚀 Iniciando proxy HLS...');
    await renewToken();
    if (!m3u8Url) setInterval(async () => { if (!m3u8Url) await renewToken(); }, 10000);
    setInterval(fetchAndRewriteManifest, MANIFEST_REFRESH_SEC * 1000);
    setInterval(renewToken, TOKEN_RENEW_SEC * 1000);
    app.listen(PORT, () => {
        console.log(`\n🚀 Proxy en http://localhost:${PORT}`);
        console.log(`🎥 Stream: http://localhost:${PORT}/stream`);
    });
}

start();

process.on('SIGINT', () => { if (activeFFmpeg) activeFFmpeg.kill('SIGTERM'); process.exit(0); });
process.on('SIGTERM', () => { if (activeFFmpeg) activeFFmpeg.kill('SIGTERM'); process.exit(0); });

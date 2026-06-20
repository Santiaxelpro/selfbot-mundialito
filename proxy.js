require('dotenv').config();
const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
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
let activeClients = new Set();
let ffmpegRestartScheduled = false;
let manifestInterval = null;
let tokenInterval = null;
let retryInterval = null;

const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 4,
    maxFreeSockets: 2,
    timeout: 60000,
});
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 4,
    maxFreeSockets: 2,
    timeout: 60000,
});

const sharedAxios = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 15000,
    maxRedirects: 3,
});

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': 'https://tvtvhd.com/',
    'Origin': 'https://tvtvhd.com',
    'Accept': '*/*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Connection': 'keep-alive',
};

let browser = null;
let browserErrorCount = 0;
const MAX_BROWSER_ERRORS = 3;

function logMem(label) {
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    if (rssMB > 350 || heapMB > 150) {
        console.warn('[MEM] ' + label + ': RSS=' + rssMB + 'MB Heap=' + heapMB + 'MB');
    }
}

async function getBrowser() {
    if (browser && browser.isConnected()) {
        return browser;
    }
    if (browser) {
        try { await browser.close(); } catch (_) {}
        browser = null;
    }
    if (browserErrorCount >= MAX_BROWSER_ERRORS) {
        console.error('[BROWSER] Demasiados errores, esperando 60s...');
        await new Promise(r => setTimeout(r, 60000));
        browserErrorCount = 0;
    }
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
        executablePath,
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--single-process',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-translate',
            '--disable-default-apps',
            '--hide-scrollbars',
            '--mute-audio',
            '--no-first-run',
            '--disable-component-update',
            '--disable-breakpad',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-features=TranslateUI,site-per-process,BlinkGenPropertyTrees',
            '--disable-ipc-flooding-protection',
            '--memory-pressure-off',
            '--js-flags=--max-old-space-size=64',
        ],
        headless: chromium.headless,
        defaultViewport: chromium.defaultViewport,
        ignoreHTTPSErrors: true,
    });
    browserErrorCount = 0;
    return browser;
}

async function closeBrowser() {
    if (browser) {
        try { await browser.close(); } catch (_) {}
        browser = null;
    }
    if (global.gc) global.gc();
}

async function renewToken() {
    if (isRenewing) return;
    isRenewing = true;
    console.log('[TOKEN] Renovando...');
    let page = null;
    try {
        const b = await getBrowser();
        page = await b.newPage();
        await page.setRequestInterception(true);
        let capturedUrl = null;
        const requestHandler = (req) => {
            const url = req.url();
            if (url.includes('.m3u8') && !capturedUrl) {
                capturedUrl = url;
                console.log('[TOKEN] M3U8 capturado: ' + url.substring(0, 80) + '...');
            }
            req.continue();
        };
        page.on('request', requestHandler);
        await page.goto(TARGET_PAGE, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (!capturedUrl) {
            capturedUrl = await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video && video.src && video.src.includes('.m3u8')) return video.src;
                const source = document.querySelector('source[src*=".m3u8"]');
                if (source && source.src) return source.src;
                const scripts = Array.from(document.querySelectorAll('script'));
                for (let i = 0; i < scripts.length; i++) {
                    const txt = scripts[i].textContent;
                    if (txt) {
                        const match = txt.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
                        if (match) return match[0];
                    }
                }
                return null;
            });
        }
        if (capturedUrl) {
            m3u8Url = capturedUrl;
            lastTokenRenew = Date.now();
            await fetchAndRewriteManifest();
            restartFFmpeg();
            if (retryInterval) {
                clearInterval(retryInterval);
                retryInterval = null;
            }
        } else {
            console.error('[TOKEN] No se encontró M3U8');
        }
    } catch (error) {
        console.error('[TOKEN] Error: ' + error.message);
        browserErrorCount++;
        if (browserErrorCount >= MAX_BROWSER_ERRORS) {
            await closeBrowser();
        }
    } finally {
        if (page) {
            page.removeAllListeners('request');
            page.removeAllListeners('response');
            page.removeAllListeners('dialog');
            try { await page.close(); } catch (_) {}
        }
        isRenewing = false;
        logMem('renewToken end');
        if (global.gc) global.gc();
    }
}

async function fetchAndRewriteManifest() {
    if (!m3u8Url) {
        if (!isRenewing) await renewToken();
        return;
    }
    try {
        const response = await sharedAxios.get(m3u8Url, {
            timeout: 15000,
            responseType: 'text',
            headers: REQUEST_HEADERS,
        });
        if (response.status === 403 || response.status === 401) {
            console.log('[MANIFEST] Token expirado (HTTP ' + response.status + ')');
            if (!isRenewing) await renewToken();
            return;
        }
        if (response.status !== 200) throw new Error('Status ' + response.status);
        const rawContent = response.data;
        if (!rawContent || !rawContent.includes('#EXT')) {
            console.log('[MANIFEST] Contenido inválido, reintentando...');
            if (!isRenewing) await renewToken();
            return;
        }
        const parsed = new URL(m3u8Url);
        originBaseUrl = parsed.protocol + '//' + parsed.host + parsed.pathname.substring(0, parsed.pathname.lastIndexOf('/') + 1);
        const lines = rawContent.split('\n');
        let segCount = 0;
        const rewritten = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && /\.(ts|m4s|mp4)\b/i.test(trimmed)) {
                rewritten.push('/segment?url=' + encodeURIComponent(new URL(trimmed, originBaseUrl).href));
                segCount++;
            } else {
                rewritten.push(line);
            }
        }
        manifestContent = rewritten.join('\n');
        console.log('[MANIFEST] Actualizado: ' + segCount + ' segmentos');
    } catch (error) {
        console.error('[MANIFEST] Error: ' + error.message);
        if (error.response && (error.response.status === 403 || error.response.status === 401)) {
            if (!isRenewing) await renewToken();
        }
    }
}

function startFFmpeg() {
    if (activeFFmpeg) {
        killFFmpeg();
    }
    if (!m3u8Url) {
        console.log('[FFMPEG] Esperando token...');
        if (!ffmpegRestartScheduled) {
            ffmpegRestartScheduled = true;
            setTimeout(() => {
                ffmpegRestartScheduled = false;
                if (activeClients.size > 0) startFFmpeg();
            }, 2000);
        }
        return;
    }
    if (activeClients.size === 0) return;
    console.log('[FFMPEG] Iniciando...');
    const ffmpeg = spawn('ffmpeg', [
        '-re',
        '-stream_loop', '-1',
        '-i', m3u8Url,
        '-c:v', 'libx264',
        '-profile:v', 'baseline',
        '-level', '3.0',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', '800k',
        '-maxrate', '1000k',
        '-bufsize', '1500k',
        '-c:a', 'aac',
        '-b:a', '48k',
        '-ar', '22050',
        '-ac', '1',
        '-f', 'mpegts',
        '-flush_packets', '1',
        '-fflags', 'nobuffer+discardcorrupt',
        '-flags', 'low_delay',
        '-threads', '1',
        '-rtbufsize', '128K',
        'pipe:1',
    ]);

    let stderrLog = '';
    let stderrTimer = null;
    ffmpeg.stderr.on('data', (data) => {
        stderrLog += data.toString();
        if (stderrTimer) clearTimeout(stderrTimer);
        stderrTimer = setTimeout(() => {
            const trimmed = stderrLog.trim();
            if (trimmed) console.error('[FFMPEG] ' + trimmed.split('\n').pop());
            stderrLog = '';
        }, 2000);
    });

    ffmpeg.stdout.on('data', (chunk) => {
        for (const clientStream of activeClients) {
            if (!clientStream.destroyed) {
                clientStream.write(chunk);
            }
        }
    });

    ffmpeg.on('error', (err) => {
        console.error('[FFMPEG] Error de proceso: ' + err.message);
    });

    ffmpeg.on('close', (code) => {
        if (stderrTimer) clearTimeout(stderrTimer);
        stderrTimer = null;
        stderrLog = '';
        ffmpeg.stdout.removeAllListeners('data');
        ffmpeg.stderr.removeAllListeners('data');
        ffmpeg.removeAllListeners();
        console.log('[FFMPEG] Terminó (code=' + code + ')');
        if (activeFFmpeg === ffmpeg) {
            activeFFmpeg = null;
        }
        if (activeClients.size > 0 && m3u8Url) {
            console.log('[FFMPEG] Reiniciando para ' + activeClients.size + ' clientes...');
            setTimeout(() => {
                if (activeClients.size > 0) startFFmpeg();
            }, 1500);
        }
        logMem('ffmpeg close');
        if (global.gc) global.gc();
    });

    activeFFmpeg = ffmpeg;
    logMem('ffmpeg start');
}

function killFFmpeg() {
    if (!activeFFmpeg) return;
    const ffmpeg = activeFFmpeg;
    activeFFmpeg = null;
    ffmpeg.stdout.removeAllListeners('data');
    ffmpeg.stderr.removeAllListeners('data');
    ffmpeg.removeAllListeners();
    try { ffmpeg.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
        try { ffmpeg.kill('SIGKILL'); } catch (_) {}
    }, 3000);
}

function restartFFmpeg() {
    killFFmpeg();
    if (activeClients.size > 0) {
        setTimeout(() => startFFmpeg(), 1000);
    }
}

function removeClient(clientStream) {
    activeClients.delete(clientStream);
    clientStream.destroy();
}

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

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
        const response = await sharedAxios({
            method: 'get',
            url: targetUrl,
            responseType: 'stream',
            timeout: 30000,
            headers: REQUEST_HEADERS,
        });
        res.set('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'no-cache');
        response.data.pipe(res);
        response.data.on('error', () => {
            try { response.data.unpipe(res); } catch (_) {}
            if (!res.headersSent) res.status(500).end();
        });
    } catch (error) {
        if (!res.headersSent) {
            res.status(error.response ? error.response.status : 502).send('Error al obtener segmento');
        }
    }
});

app.get('/stream', (req, res) => {
    if (!m3u8Url) return res.status(503).json({ error: 'Token no disponible' });
    res.set({
        'Content-Type': 'video/MP2T',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'Connection': 'keep-alive',
    });

    const clientStream = new PassThrough({ highWaterMark: 256 * 1024 });
    activeClients.add(clientStream);
    console.log('[CLIENT] Conectado (' + activeClients.size + ' totales)');

    if (!activeFFmpeg) startFFmpeg();

    clientStream.pipe(res, { end: true });

    const cleanup = () => {
        removeClient(clientStream);
        console.log('[CLIENT] Desconectado (' + activeClients.size + ' restantes)');
        if (activeClients.size === 0) {
            killFFmpeg();
        }
        logMem('client disconnect');
    };

    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('close', cleanup);
});

app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: manifestContent ? 'ok' : 'initializing',
        hasToken: !!m3u8Url,
        clients: activeClients.size,
        ffmpegRunning: !!activeFFmpeg,
        browserAlive: browser ? browser.isConnected() : false,
        memRSS_MB: Math.round(mem.rss / 1024 / 1024),
        memHeap_MB: Math.round(mem.heapUsed / 1024 / 1024),
        uptime_s: Math.round(process.uptime()),
    });
});

async function start() {
    console.log('[START] Iniciando proxy HLS...');
    await renewToken();
    if (!m3u8Url) {
        console.log('[START] M3U8 no disponible aún, reintentando cada 10s...');
        retryInterval = setInterval(async () => {
            if (!m3u8Url && !isRenewing) await renewToken();
        }, 10000);
    }
    if (!manifestContent && m3u8Url) {
        await fetchAndRewriteManifest();
    }
    manifestInterval = setInterval(async () => {
        if (!isRenewing) await fetchAndRewriteManifest();
    }, MANIFEST_REFRESH_SEC * 1000);
    tokenInterval = setInterval(async () => {
        if (!isRenewing) await renewToken();
    }, TOKEN_RENEW_SEC * 1000);
    setInterval(() => {
        logMem('periodic');
        const mem = process.memoryUsage();
        if (mem.rss > 450 * 1024 * 1024) {
            console.warn('[MEM] RSS > 450MB, limpiando...');
            if (activeClients.size === 0) killFFmpeg();
            closeBrowser();
            if (global.gc) global.gc();
        }
    }, 300000);
    app.listen(PORT, () => {
        console.log('[START] Proxy en http://localhost:' + PORT);
        console.log('[START] Stream: http://localhost:' + PORT + '/stream');
    });
}

start();

function gracefulShutdown(signal) {
    console.log('[SHUTDOWN] ' + signal);
    if (manifestInterval) clearInterval(manifestInterval);
    if (tokenInterval) clearInterval(tokenInterval);
    if (retryInterval) clearInterval(retryInterval);
    killFFmpeg();
    for (const client of activeClients) {
        client.destroy();
    }
    activeClients.clear();
    httpAgent.destroy();
    httpsAgent.destroy();
    if (browser) {
        try { browser.close(); } catch (_) {}
        browser = null;
    }
    process.exit(0);
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    console.error('[FATAL] ' + err.message);
    if (err.message && (err.message.includes('ECONNRESET') || err.message.includes('ETIMEDOUT'))) return;
    gracefulShutdown('uncaughtException');
});

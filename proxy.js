require('dotenv').config();
const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { spawn } = require('child_process');
const { URL } = require('url');
const fs = require('fs');

// ========= CONFIGURACIÓN =========
const PORT = process.env.PORT || 25553;
const TARGET_PAGE = process.env.PROXY_TARGET_URL || 'https://tvtvhd.com/tv/canales.php?stream=dsports';

const MANIFEST_REFRESH_SEC = 10;      // Actualizar manifiesto cada 10s
const TOKEN_RENEW_SEC = 300;          // Renovar token cada 5 min

// ========= ESTADO GLOBAL =========
let m3u8Url = null;                   // URL del .m3u8 con token
let manifestContent = null;           // Manifiesto reescrito
let originBaseUrl = null;
let lastTokenRenew = 0;
let isRenewing = false;
let currentStreamProcess = null;      // Proceso FFmpeg para /stream
let streamClients = 0;                // Contador de clientes conectados al stream

// ========= HEADERS =========
const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://tvtvhd.com/',
    'Origin': 'https://tvtvhd.com',
    'Accept': '*/*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Connection': 'keep-alive'
};

// ========= RENOVAR TOKEN CON PUPPETEER =========
async function renewToken() {
    if (isRenewing) return;
    isRenewing = true;
    console.log('🔄 Renovando token desde la página web...');
    let browser = null;
    try {
        const executablePath = await chromium.executablePath();
        browser = await puppeteer.launch({
            executablePath,
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--ignore-certificate-errors',
                '--disable-web-security',
                '--allow-running-insecure-content'
            ],
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
            console.log(`✅ Token renovado: ${m3u8Url}`);
            await fetchAndRewriteManifest();
            // Reiniciar el stream si hay clientes
            restartStreamProcess();
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

// ========= OBTENER Y REESCRIBIR MANIFIESTO =========
async function fetchAndRewriteManifest() {
    if (!m3u8Url) {
        await renewToken();
        return;
    }
    try {
        const response = await axios.get(m3u8Url, {
            timeout: 15000,
            responseType: 'text',
            headers: REQUEST_HEADERS
        });
        if (response.status === 403) {
            console.log('⚠️ Token expirado (403), renovando...');
            await renewToken();
            return;
        }
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

// ========= INICIAR PROCESO FFMPEG PARA STREAM CONTINUO =========
function startStreamProcess() {
    if (currentStreamProcess) {
        currentStreamProcess.kill('SIGTERM');
        currentStreamProcess = null;
    }

    // Solo si hay clientes conectados o si queremos mantenerlo siempre activo
    if (streamClients === 0) {
        console.log('⏸️ Sin clientes, no inicio FFmpeg.');
        return;
    }

    if (!m3u8Url) {
        console.log('⏳ Esperando token para iniciar stream...');
        return;
    }

    console.log('🎥 Iniciando proceso FFmpeg para stream continuo...');
    const ffmpeg = spawn('ffmpeg', [
        '-re',
        '-i', m3u8Url,               // URL del manifiesto con token
        '-c:v', 'copy',              // Copiar video sin recodificar
        '-c:a', 'copy',              // Copiar audio sin recodificar
        '-f', 'mpegts',             // Salida MPEG-TS (aceptado por Discord)
        '-mpegts_flags', 'resend_headers',
        '-flush_packets', '1',
        'pipe:1'
    ]);

    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('error') || msg.includes('Error')) {
            console.error(`FFmpeg stderr: ${msg.trim()}`);
        }
    });

    ffmpeg.on('close', (code) => {
        console.log(`FFmpeg finalizado con código ${code}`);
        if (code !== 0 && streamClients > 0) {
            console.log('Reiniciando FFmpeg en 2s...');
            setTimeout(() => startStreamProcess(), 2000);
        }
        currentStreamProcess = null;
    });

    ffmpeg.on('error', (err) => {
        console.error('Error en FFmpeg:', err.message);
        currentStreamProcess = null;
    });

    currentStreamProcess = ffmpeg;
}

function restartStreamProcess() {
    if (currentStreamProcess) {
        currentStreamProcess.kill('SIGTERM');
        currentStreamProcess = null;
    }
    if (streamClients > 0) {
        setTimeout(() => startStreamProcess(), 1000);
    }
}

// ========= SERVIDOR EXPRESS =========
const app = express();

// Endpoint para obtener el manifiesto (para compatibilidad)
app.get('/manifest', (req, res) => {
    if (!manifestContent) {
        return res.status(503).send('Stream no disponible aún.');
    }
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(manifestContent);
});

// Endpoint para servir segmentos (usado por el manifiesto)
app.get('/segment', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Falta url');
    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            responseType: 'stream',
            timeout: 30000,
            headers: REQUEST_HEADERS
        });
        res.set('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'no-cache');
        response.data.pipe(res);
    } catch (error) {
        console.error(`❌ Error al servir segmento: ${error.message}`);
        if (!res.headersSent) res.status(500).send('Error al obtener segmento');
    }
});

// **NUEVO: Endpoint para el flujo continuo MPEG-TS**
app.get('/stream', (req, res) => {
    if (!m3u8Url) {
        return res.status(503).send('Token aún no disponible. Espere unos segundos.');
    }

    // Configurar headers para streaming
    res.set({
        'Content-Type': 'video/MP2T',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'Connection': 'keep-alive'
    });

    streamClients++;
    console.log(`📡 Nuevo cliente conectado al stream (${streamClients} totales)`);

    // Si no hay proceso FFmpeg, iniciarlo
    if (!currentStreamProcess) {
        startStreamProcess();
    }

    // Pipe de la salida de FFmpeg al cliente
    if (currentStreamProcess) {
        currentStreamProcess.stdout.pipe(res);
    } else {
        // Si no hay proceso, enviar error
        res.status(503).send('No se pudo iniciar el stream');
        streamClients--;
        return;
    }

    // Cuando el cliente se desconecta
    req.on('close', () => {
        streamClients--;
        console.log(`📡 Cliente desconectado (${streamClients} restantes)`);
        // Si no hay más clientes, matar FFmpeg para ahorrar recursos
        if (streamClients === 0 && currentStreamProcess) {
            console.log('⏹️ Sin clientes, deteniendo FFmpeg...');
            currentStreamProcess.kill('SIGTERM');
            currentStreamProcess = null;
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: manifestContent ? 'ok' : 'initializing',
        hasToken: !!m3u8Url,
        lastRenew: lastTokenRenew,
        clients: streamClients,
        ffmpegRunning: !!currentStreamProcess
    });
});

// ========= INICIALIZACIÓN =========
async function start() {
    console.log('🚀 Iniciando proxy HLS con stream continuo...');
    await renewToken();

    if (!m3u8Url) {
        setInterval(async () => { if (!m3u8Url) await renewToken(); }, 10000);
    }

    setInterval(fetchAndRewriteManifest, MANIFEST_REFRESH_SEC * 1000);
    setInterval(renewToken, TOKEN_RENEW_SEC * 1000);

    app.listen(PORT, () => {
        console.log(`\n🚀 Proxy corriendo en http://localhost:${PORT}`);
        console.log(`📡 Manifiesto: http://localhost:${PORT}/manifest`);
        console.log(`🎥 Stream continuo: http://localhost:${PORT}/stream`);
        console.log(`💡 Abre en VLC: http://localhost:${PORT}/stream`);
    });
}

start();

process.on('SIGINT', () => {
    if (currentStreamProcess) currentStreamProcess.kill('SIGTERM');
    process.exit(0);
});
process.on('SIGTERM', () => {
    if (currentStreamProcess) currentStreamProcess.kill('SIGTERM');
    process.exit(0);
});

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { URL } = require('url');

// ========= CONFIGURACIÓN =========
const PORT = process.env.PORT || 25553;
const TARGET_PAGE = process.env.PROXY_TARGET_URL || 'https://tvtvhd.com/tv/canales.php?stream=dsports';

// Intervalos
const MANIFEST_REFRESH_SEC = 10;      // Actualizar el manifiesto cada 10s
const TOKEN_RENEW_SEC = 300;          // Renovar el token cada 5 minutos (o cuando expire)

// ========= ESTADO GLOBAL =========
let m3u8Url = null;                   // URL actual del .m3u8 con token
let manifestContent = null;           // Manifiesto reescrito
let originBaseUrl = null;
let lastTokenRenew = 0;
let isRenewing = false;

// ========= HEADERS PARA PETICIONES =========
const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://tvtvhd.com/',
    'Origin': 'https://tvtvhd.com',
    'Accept': '*/*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Connection': 'keep-alive'
};

// ========= FUNCIÓN PARA OBTENER NUEVO TOKEN CON PUPPETEER (ARM64) =========
async function renewToken() {
    if (isRenewing) return;
    isRenewing = true;

    console.log('🔄 Renovando token desde la página web...');
    let browser = null;

    try {
        // Obtener el ejecutable de Chromium para ARM64
        const executablePath = await chromium.executablePath();
        console.log(`📂 Chromium: ${executablePath}`);

        browser = await puppeteer.launch({
            executablePath: executablePath,
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--ignore-certificate-errors',
                '--disable-web-security',
                '--allow-running-insecure-content',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ],
            headless: chromium.headless,
            defaultViewport: chromium.defaultViewport,
        });

        const page = await browser.newPage();
        let capturedUrl = null;

        // Interceptar peticiones para capturar el .m3u8
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (url.includes('.m3u8') && !capturedUrl) {
                capturedUrl = url;
                console.log(`✅ M3U8 capturado: ${url}`);
            }
            req.continue();
        });

        // Navegar a la página
        console.log(`🌐 Navegando a ${TARGET_PAGE}...`);
        await page.goto(TARGET_PAGE, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // Esperar un poco para que el reproductor cargue
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Si no se capturó, intentar extraer del DOM
        if (!capturedUrl) {
            console.log('⚠️ No se interceptó, buscando en el DOM...');
            capturedUrl = await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video && video.src && video.src.includes('.m3u8')) return video.src;
                const source = document.querySelector('source[src*=".m3u8"]');
                if (source && source.src) return source.src;
                const scripts = Array.from(document.querySelectorAll('script'));
                for (let script of scripts) {
                    const text = script.textContent;
                    if (text) {
                        const match = text.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
                        if (match) return match[0];
                    }
                }
                return null;
            });
        }

        if (capturedUrl) {
            m3u8Url = capturedUrl;
            lastTokenRenew = Date.now();
            console.log(`✅ Token renovado exitosamente: ${m3u8Url}`);
            // Limpiar el manifiesto para que se reobtenga
            manifestContent = null;
            // Obtener el manifiesto inmediatamente
            await fetchAndRewriteManifest();
        } else {
            console.error('❌ No se pudo obtener la URL del M3U8');
        }

    } catch (error) {
        console.error('❌ Error al renovar token:', error.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        isRenewing = false;
    }
}

// ========= OBTENER Y REESCRIBIR EL MANIFIESTO =========
async function fetchAndRewriteManifest() {
    if (!m3u8Url) {
        console.log('⏳ No hay URL del manifiesto, renovando token...');
        await renewToken();
        return;
    }

    try {
        console.log('🔄 Obteniendo manifiesto...');
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

        if (response.status !== 200) {
            throw new Error(`Status ${response.status}`);
        }

        const rawContent = response.data;
        const parsed = new URL(m3u8Url);
        originBaseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname.substring(0, parsed.pathname.lastIndexOf('/') + 1)}`;

        // Reescribir las URLs de los segmentos
        const lines = rawContent.split('\n');
        const rewritten = lines.map(line => {
            if (line.trim() && !line.startsWith('#') && line.includes('.ts')) {
                let absoluteUrl;
                try {
                    absoluteUrl = new URL(line, originBaseUrl).href;
                } catch (_) {
                    absoluteUrl = new URL(line, originBaseUrl).href;
                }
                return `/segment?url=${encodeURIComponent(absoluteUrl)}`;
            }
            return line;
        });

        manifestContent = rewritten.join('\n');
        console.log(`✅ Manifiesto actualizado (${rawContent.length} bytes, ${rewritten.filter(l => l.startsWith('/segment')).length} segmentos)`);

    } catch (error) {
        console.error('❌ Error al obtener manifiesto:', error.message);
        if (error.response && error.response.status === 403) {
            console.log('⚠️ Token expirado, renovando...');
            await renewToken();
        }
    }
}

// ========= SERVIDOR EXPRESS =========
const app = express();

app.get('/manifest', (req, res) => {
    if (!manifestContent) {
        return res.status(503).send('Stream no disponible aún. Espere unos segundos.');
    }
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(manifestContent);
});

app.get('/segment', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('Falta parámetro url');
    }

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
        if (!res.headersSent) {
            res.status(500).send('Error al obtener segmento');
        }
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: manifestContent ? 'ok' : 'initializing',
        hasToken: !!m3u8Url,
        lastRenew: lastTokenRenew,
        hasContent: !!manifestContent
    });
});

// ========= INICIALIZACIÓN =========
async function start() {
    console.log('🚀 Iniciando proxy HLS con renovación automática...');
    
    // Obtener el token inicial
    await renewToken();

    // Si no hay token, reintentar cada 10s
    if (!m3u8Url) {
        console.log('⚠️ No se pudo obtener el token inicial, reintentando cada 10s...');
        setInterval(async () => {
            if (!m3u8Url) await renewToken();
        }, 10000);
    }

    // Actualizar el manifiesto periódicamente (cada 10s)
    setInterval(async () => {
        await fetchAndRewriteManifest();
    }, MANIFEST_REFRESH_SEC * 1000);

    // Renovar el token periódicamente (cada 5 minutos)
    setInterval(async () => {
        await renewToken();
    }, TOKEN_RENEW_SEC * 1000);

    app.listen(PORT, () => {
        console.log(`\n🚀 Proxy HLS corriendo en http://localhost:${PORT}/manifest`);
        console.log(`📡 Página origen: ${TARGET_PAGE}`);
        console.log(`🔄 Manifiesto cada ${MANIFEST_REFRESH_SEC}s, Token cada ${TOKEN_RENEW_SEC}s`);
        console.log(`💡 Abre en VLC: http://localhost:${PORT}/manifest`);
    });
}

start();

process.on('SIGINT', () => {
    console.log('🛑 Cerrando...');
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('🛑 Cerrando...');
    process.exit(0);
});

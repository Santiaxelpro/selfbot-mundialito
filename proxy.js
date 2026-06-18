require('dotenv').config();
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { spawn } = require('child_process');
const http = require('http');

// === CONFIGURACIÓN OPTIMIZADA (ajustable por variables de entorno) ===
const PORT = process.env.PORT || 8888;
const TARGET_URL = process.env.PROXY_TARGET_URL || 'https://sudamericaplay2.com/canal_8112/cza_dsports.html';

// Parámetros de calidad/rendimiento
const VIEWPORT_WIDTH  = parseInt(process.env.VIDEO_WIDTH)  || 640;
const VIEWPORT_HEIGHT = parseInt(process.env.VIDEO_HEIGHT) || 360;
const FPS             = parseInt(process.env.FPS)          || 15;
const VIDEO_BITRATE   = process.env.VIDEO_BITRATE  || '800k';
const VIDEO_PRESET    = process.env.VIDEO_PRESET   || 'ultrafast';
const VIDEO_TUNE      = process.env.VIDEO_TUNE     || 'zerolatency';
const SCREENCAST_QUAL = parseInt(process.env.SCREENCAST_QUALITY) || 70;
const AUDIO_ENABLED   = process.env.AUDIO_ENABLED === 'true';

// Menos frames capturados para alinear con FPS bajo (cada 2 frames si FPS <= 15)
const EVERY_NTH_FRAME = FPS <= 15 ? 2 : 1;

// Audio reducido o desactivado
const AUDIO_SAMPLE_RATE = AUDIO_ENABLED ? 22050 : 8000; // Si está desactivado, se usa un sample rate bajo (no se usa realmente)
const AUDIO_CHANNELS   = 2;
const AUDIO_BITRATE    = '64k';

// Tiempos
const RECONNECT_DELAY_MS = 10000;
const FFMPEG_RESTART_DELAY_MS = 3000;

// === ESTADO GLOBAL ===
let clients = new Set();
let ffmpeg = null;
let browser = null;
let cdpSession = null;
let browserConnected = false;
let audioBuffer = [];
let hasAudio = false;
let audioFeedInterval = null;
let shutdownInProgress = false;
let statsInterval = null;

// === FUNCIONES DE AUDIO (solo si está habilitado) ===
function floatsToPCM(floats) {
    const buf = Buffer.allocUnsafe(floats.length * 2);
    for (let i = 0; i < floats.length; i++) {
        const v = Math.max(-1, Math.min(1, floats[i]));
        buf.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7FFF, i * 2);
    }
    return buf;
}

function startFFmpeg() {
    if (shutdownInProgress || !cdpSession) return;

    if (ffmpeg) {
        ffmpeg.kill();
        ffmpeg = null;
    }

    console.log(`FFmpeg: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT} @ ${FPS}fps | ${VIDEO_BITRATE} ${VIDEO_PRESET}/${VIDEO_TUNE}`);
    console.log(`Audio: ${AUDIO_ENABLED ? 'capturado' : 'desactivado'}`);

    const args = [
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-framerate', String(FPS),
        '-i', 'pipe:0',
        '-c:v', 'libx264',
        '-preset', VIDEO_PRESET,
        '-tune', VIDEO_TUNE,
        '-b:v', VIDEO_BITRATE,
        '-maxrate', String(parseInt(VIDEO_BITRATE) * 1.5) + 'k',
        '-bufsize', String(parseInt(VIDEO_BITRATE) * 2) + 'k',
        '-g', String(FPS * 2),
        '-keyint_min', String(FPS),
        '-sc_threshold', '40',
        '-refs', '1',               // menos referencias = menos CPU
        '-bf', '0',                 // sin B-frames para menor latencia y CPU
        '-s', `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
        '-r', String(FPS),
        '-f', 'mpegts',
        '-muxdelay', '0',
        '-threads', '1',            // un solo hilo para reducir uso de CPU
        'pipe:1'
    ];

    // Si audio está habilitado, añadimos entrada de audio
    if (AUDIO_ENABLED) {
        args.splice(4, 0, 
            '-f', 's16le',
            '-ar', String(AUDIO_SAMPLE_RATE),
            '-ac', String(AUDIO_CHANNELS),
            '-i', 'pipe:3'
        );
        args.splice(12, 0, 
            '-c:a', 'aac',
            '-b:a', AUDIO_BITRATE,
            '-ar', String(AUDIO_SAMPLE_RATE),
            '-ac', String(AUDIO_CHANNELS)
        );
    }

    ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });

    ffmpeg.stdout.on('data', (data) => {
        if (clients.size === 0) return;
        for (const client of clients) {
            if (!client.destroyed) {
                client.write(data);
            }
        }
    });

    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('bitrate=')) {
            const match = msg.match(/bitrate=\s*(\d+(?:\.\d+)?)\s*kbits\/s/);
            if (match) {
                console.log(`Bitrate: ${match[1]} kbps | Clientes: ${clients.size}`);
            }
        }
        // No mostramos logs de error para no saturar
    });

    ffmpeg.on('exit', (code) => {
        console.log(`FFmpeg finalizado (código ${code})`);
        ffmpeg = null;
        if (audioFeedInterval) {
            clearInterval(audioFeedInterval);
            audioFeedInterval = null;
        }
        if (code !== 0 && clients.size > 0 && !shutdownInProgress) {
            setTimeout(startFFmpeg, FFMPEG_RESTART_DELAY_MS);
        }
    });

    ffmpeg.on('error', (err) => {
        console.error(`FFmpeg error: ${err.message}`);
        ffmpeg = null;
        if (audioFeedInterval) {
            clearInterval(audioFeedInterval);
            audioFeedInterval = null;
        }
        if (clients.size > 0 && !shutdownInProgress) {
            setTimeout(startFFmpeg, FFMPEG_RESTART_DELAY_MS);
        }
    });

    // Si audio está habilitado, configuramos el envío periódico
    if (AUDIO_ENABLED) {
        audioFeedInterval = setInterval(() => {
            if (!ffmpeg || !ffmpeg.stdio[3] || ffmpeg.stdio[3].destroyed) return;
            try {
                if (audioBuffer.length > 0) {
                    const chunk = Buffer.concat(audioBuffer.splice(0, audioBuffer.length));
                    ffmpeg.stdio[3].write(chunk);
                } else if (!hasAudio) {
                    const samplesPerFrame = Math.floor(AUDIO_SAMPLE_RATE / FPS);
                    const silence = Buffer.alloc(samplesPerFrame * 2 * AUDIO_CHANNELS);
                    ffmpeg.stdio[3].write(silence);
                }
            } catch (_) {}
        }, 1000 / FPS);
    } else {
        // Si no hay audio, no usamos pipe:3, lo ignoramos
    }
}

async function setupAudioCapture(page) {
    if (!AUDIO_ENABLED) return false;
    try {
        await page.exposeFunction('__sendAudio', (data) => {
            if (!hasAudio) {
                hasAudio = true;
                console.log('Audio capturado');
            }
            const buf = floatsToPCM(data);
            audioBuffer.push(buf);
            // Limitar buffer para evitar crecimiento excesivo
            if (audioBuffer.length > 20) audioBuffer.shift();
        });

        const result = await page.evaluate(() => {
            const video = document.querySelector('video');
            if (!video) return false;

            try {
                const ctx = new AudioContext({ sampleRate: 22050 });
                const source = ctx.createMediaElementSource(video);
                const processor = ctx.createScriptProcessor(4096, 2, 2); // buffer más grande = menos llamadas
                processor.onaudioprocess = (e) => {
                    const left = e.inputBuffer.getChannelData(0);
                    const right = e.inputBuffer.getChannelData(1);
                    const interleaved = new Float32Array(left.length * 2);
                    for (let i = 0; i < left.length; i++) {
                        interleaved[i * 2] = left[i];
                        interleaved[i * 2 + 1] = right[i];
                    }
                    window.__sendAudio(Array.from(interleaved));
                };
                source.connect(processor);
                processor.connect(ctx.destination);
                return true;
            } catch (e) {
                return false;
            }
        });

        if (!result) console.log('Audio: no disponible.');
        return result;
    } catch (err) {
        console.log(`Audio: error - ${err.message}`);
        return false;
    }
}

function setupVideoMuteOverride(page) {
    page.on('framenavigated', async () => {
        try {
            await page.evaluate(() => {
                document.querySelectorAll('video, audio').forEach(el => {
                    el.muted = false;
                    el.volume = 1.0;
                });
            });
        } catch (_) {}
    });
}

async function startBrowser() {
    if (browserConnected || shutdownInProgress) return;

    console.log(`Navegador: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT} | FPS: ${FPS}`);
    console.log(`URL: ${TARGET_URL}`);

    try {
        browser = await puppeteer.launch({
            executablePath: await chromium.executablePath(),
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-translate',
                '--disable-features=TranslateUI,PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
                '--autoplay-policy=no-user-gesture-required',
                `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
                '--hide-scrollbars',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-renderer-backgrounding',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-ipc-flooding-protection',
                '--memory-pressure-off',
                '--enable-features=NetworkService,NetworkServiceInProcess',
                '--force-color-profile=srgb',
                '--disable-logging',
                '--log-level=3',
                '--silent',
                '--disable-accelerated-2d-canvas',
                '--disable-canvas-aa',
                '--disable-software-rasterizer',
                '--js-flags="--max-old-space-size=256"',  // límite de memoria V8
                '--single-process'                        // reduce procesos (memoria) a costa de estabilidad, pero necesario
            ],
            headless: 'new',  // más ligero
            defaultViewport: {
                width: VIEWPORT_WIDTH,
                height: VIEWPORT_HEIGHT,
            },
        });

        browserConnected = true;

        const page = await browser.newPage();
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
                set: () => {},
                get: () => false
            });
        });

        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        await page.evaluate(() => {
            document.querySelectorAll('video, audio').forEach(el => {
                el.muted = false;
                el.volume = 1.0;
                el.play().catch(() => {});
            });
            document.querySelectorAll('button, [role="button"]').forEach(btn => {
                const text = btn.textContent?.toLowerCase() || '';
                if (text.includes('unmute') || text.includes('activar sonido') || text.includes('audio')) {
                    btn.click();
                }
            });
        });

        setupVideoMuteOverride(page);

        cdpSession = await page.target().createCDPSession();
        await cdpSession.send('Page.startScreencast', {
            format: 'jpeg',
            quality: SCREENCAST_QUAL,
            maxWidth: VIEWPORT_WIDTH,
            maxHeight: VIEWPORT_HEIGHT,
            everyNthFrame: EVERY_NTH_FRAME
        });

        cdpSession.on('Page.screencastFrame', ({ data, sessionId }) => {
            if (ffmpeg && ffmpeg.stdin && ffmpeg.stdin.writable) {
                ffmpeg.stdin.write(Buffer.from(data, 'base64'));
            }
            cdpSession.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        });

        browser.on('disconnected', () => {
            console.log('Navegador desconectado');
            browserConnected = false;
            cdpSession = null;
            hasAudio = false;
            if (ffmpeg) {
                ffmpeg.kill();
                ffmpeg = null;
            }
            if (audioFeedInterval) {
                clearInterval(audioFeedInterval);
                audioFeedInterval = null;
            }
            if (clients.size > 0 && !shutdownInProgress) {
                setTimeout(startBrowser, RECONNECT_DELAY_MS);
            }
        });

        console.log('Screencast activo');
        if (AUDIO_ENABLED) await setupAudioCapture(page);
        startFFmpeg();

    } catch (err) {
        console.error(`Navegador: ${err.message}`);
        browserConnected = false;
        cdpSession = null;
        hasAudio = false;
        if (clients.size > 0 && !shutdownInProgress) {
            setTimeout(startBrowser, RECONNECT_DELAY_MS);
        }
    }
}

async function stopBrowser() {
    if (audioFeedInterval) {
        clearInterval(audioFeedInterval);
        audioFeedInterval = null;
    }
    if (ffmpeg) {
        ffmpeg.kill();
        ffmpeg = null;
    }
    if (browser && browserConnected) {
        await browser.close().catch(() => {});
    }
    browserConnected = false;
    cdpSession = null;
    hasAudio = false;
    audioBuffer = [];
}

// === SERVIDOR HTTP ===
const server = http.createServer((req, res) => {
    if (req.url === '/stream') {
        console.log(`Cliente conectado (${clients.size + 1} total)`);
        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.socket.setNoDelay(true);
        if (typeof res.socket.setSendBufferSize === 'function') {
            res.socket.setSendBufferSize(128 * 1024); // buffer más pequeño
        }
        clients.add(res);
        if (!browserConnected) startBrowser();
        else if (!ffmpeg) startFFmpeg();
        req.on('close', () => {
            clients.delete(res);
            console.log(`Cliente desconectado (${clients.size} restantes)`);
            if (clients.size === 0) {
                console.log('Sin clientes, deteniendo...');
                stopBrowser();
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

// === APAGADO GRACIELSO ===
async function shutdown() {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log('Cerrando proxy...');
    await stopBrowser();
    server.close(() => {
        process.exit(0);
    });
    setTimeout(() => {
        process.exit(1);
    }, 10000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// === INICIO ===
server.listen(PORT, () => {
    console.log(`Proxy: http://localhost:${PORT}/stream`);
    console.log(`Config: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT} @ ${FPS}fps | ${VIDEO_BITRATE} ${VIDEO_PRESET}/${VIDEO_TUNE}`);
    console.log(`Audio: ${AUDIO_ENABLED ? 'Habilitado' : 'Desactivado'}`);
    console.log(`Memoria límite V8: 256MB | Chromium args optimizados`);
    // Estadísticas cada 30 segundos
    statsInterval = setInterval(() => {
        const mem = process.memoryUsage();
        console.log(`📊 Memoria: RSS=${Math.round(mem.rss/1024/1024)}MB | Heap=${Math.round(mem.heapUsed/1024/1024)}MB/${Math.round(mem.heapTotal/1024/1024)}MB`);
    }, 30000);
});

require('dotenv').config();
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { spawn } = require('child_process');
const http = require('http');

// === CONFIGURACIÓN ===
const PORT = process.env.PORT || 8888;
const TARGET_URL = process.env.PROXY_TARGET_URL || 'https://sudamericaplay2.com/canal_8112/cza_dsports.html';

const VIEWPORT_WIDTH  = parseInt(process.env.VIDEO_WIDTH)  || 640;
const VIEWPORT_HEIGHT = parseInt(process.env.VIDEO_HEIGHT) || 360;
const FPS             = parseInt(process.env.FPS)          || 15;
const VIDEO_BITRATE   = process.env.VIDEO_BITRATE  || '800k';
const VIDEO_PRESET    = process.env.VIDEO_PRESET   || 'ultrafast';
const VIDEO_TUNE      = process.env.VIDEO_TUNE     || 'zerolatency';
const SCREENCAST_QUAL = parseInt(process.env.SCREENCAST_QUALITY) || 70;
const AUDIO_ENABLED   = process.env.AUDIO_ENABLED === 'true';

const EVERY_NTH_FRAME = FPS <= 15 ? 2 : 1;
const AUDIO_SAMPLE_RATE = 22050;
const AUDIO_CHANNELS   = 2;
const AUDIO_BITRATE    = '64k';

const RECONNECT_DELAY_MS = 10000;
const FFMPEG_RESTART_DELAY_MS = 3000;

// === ESTADO ===
let clients = new Set();
let ffmpeg = null;
let browser = null;
let cdpSession = null;
let browserConnected = false;
let browserStarting = false;    // evita llamadas concurrentes
let audioBuffer = [];
let hasAudio = false;
let audioFeedInterval = null;
let shutdownInProgress = false;
let statsInterval = null;
let bitrateLogCounter = 0;

// === MANEJADORES DE ERRORES GLOBALES ===
process.on('uncaughtException', (err) => {
    console.error('❌ Excepción no capturada:', err.message);
    // No salimos, solo registramos
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
});

// === FUNCIONES DE AUDIO ===
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
        // Si ya existe, no lo reiniciamos
        return;
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
        '-refs', '1',
        '-bf', '0',
        '-s', `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
        '-r', String(FPS),
        '-f', 'mpegts',
        '-muxdelay', '0',
        '-threads', '1',
        'pipe:1'
    ];

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
        // Enviar a todos los clientes activos
        for (const client of clients) {
            if (!client.destroyed && client.writable) {
                try {
                    client.write(data);
                } catch (err) {
                    // Si falla, lo eliminamos de la lista
                    clients.delete(client);
                    console.log('Cliente eliminado por error de escritura');
                }
            } else {
                clients.delete(client);
            }
        }
    });

    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('bitrate=') && bitrateLogCounter++ % 10 === 0) {
            const match = msg.match(/bitrate=\s*(\d+(?:\.\d+)?)\s*kbits\/s/);
            if (match) {
                console.log(`Bitrate: ${match[1]} kbps | Clientes: ${clients.size}`);
            }
        }
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

    if (AUDIO_ENABLED) {
        audioFeedInterval = setInterval(() => {
            if (!ffmpeg || !ffmpeg.stdio[3] || ffmpeg.stdio[3].destroyed) return;
            try {
                if (audioBuffer.length > 0) {
                    const chunk = Buffer.concat(audioBuffer.splice(0, audioBuffer.length));
                    if (ffmpeg.stdio[3].writable) {
                        ffmpeg.stdio[3].write(chunk);
                    }
                } else if (!hasAudio) {
                    const samplesPerFrame = Math.floor(AUDIO_SAMPLE_RATE / FPS);
                    const silence = Buffer.alloc(samplesPerFrame * 2 * AUDIO_CHANNELS);
                    if (ffmpeg.stdio[3].writable) {
                        ffmpeg.stdio[3].write(silence);
                    }
                }
            } catch (_) {}
        }, 1000 / FPS);
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
            if (audioBuffer.length > 20) audioBuffer.shift();
        });

        const result = await page.evaluate(() => {
            const video = document.querySelector('video');
            if (!video) return false;
            try {
                const ctx = new AudioContext({ sampleRate: 22050 });
                const source = ctx.createMediaElementSource(video);
                const processor = ctx.createScriptProcessor(4096, 2, 2);
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
    if (browserStarting || browserConnected || shutdownInProgress) return;
    browserStarting = true;

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
                '--js-flags="--max-old-space-size=384"',
                '--single-process'
            ],
            headless: 'new',
            defaultViewport: {
                width: VIEWPORT_WIDTH,
                height: VIEWPORT_HEIGHT,
            },
        });

        browserConnected = true;
        browserStarting = false;

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
                try {
                    ffmpeg.stdin.write(Buffer.from(data, 'base64'));
                } catch (err) {
                    // Si falla, ignoramos y reiniciaremos FFmpeg si es necesario
                }
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
        browserStarting = false;
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
    browserStarting = false;
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
            res.socket.setSendBufferSize(128 * 1024);
        }

        // Manejar errores del cliente para evitar EPIPE
        res.on('error', (err) => {
            if (err.code === 'EPIPE') {
                // Cliente desconectado, lo eliminamos
                clients.delete(res);
            }
        });
        res.socket.on('error', (err) => {
            if (err.code === 'EPIPE') {
                clients.delete(res);
            }
        });

        clients.add(res);

        if (!browserConnected && !browserStarting) {
            startBrowser();
        } else if (browserConnected && !ffmpeg) {
            startFFmpeg();
        }

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

// === APAGADO ===
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
    console.log(`Memoria límite V8: 384MB | Single-process mode`);

    statsInterval = setInterval(() => {
        const mem = process.memoryUsage();
        console.log(`📊 Memoria: RSS=${Math.round(mem.rss/1024/1024)}MB | Heap=${Math.round(mem.heapUsed/1024/1024)}MB/${Math.round(mem.heapTotal/1024/1024)}MB`);
    }, 30000);
});

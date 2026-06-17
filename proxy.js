require('dotenv').config();
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const http = require('http');

const PORT = 8888;
const TARGET_URL = process.env.PROXY_TARGET_URL || 'https://sudamericaplay2.com/canal_8112/cza_dsports.html';
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const FPS = 24;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;

const SCREENCAST_QUALITY = 95;
const VIDEO_BITRATE = '3000k';
const VIDEO_MAXRATE = '4000k';
const VIDEO_BUFSIZE = '6000k';
const VIDEO_GOP = 72;
const VIDEO_PRESET = 'veryfast';
const VIDEO_TUNE = 'film';
const AUDIO_BITRATE = '128k';

const RECONNECT_DELAY_MS = 5000;
const FFMPEG_RESTART_DELAY_MS = 2000;

let clients = new Set();
let ffmpeg = null;
let browser = null;
let cdpSession = null;
let browserConnected = false;
let audioBuffer = [];
let hasAudio = false;
let audioFeedInterval = null;
let shutdownInProgress = false;

function floatsToPCM(floats) {
    const buf = Buffer.allocUnsafe(floats.length * 2);
    for (let i = 0; i < floats.length; i++) {
        const v = Math.max(-1, Math.min(1, floats[i]));
        buf.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7FFF, i * 2);
    }
    return buf;
}

function startFFmpeg() {
    if (shutdownInProgress) return;
    if (ffmpeg) {
        ffmpeg.kill();
        ffmpeg = null;
    }
    if (!cdpSession) return;

    console.log(`FFmpeg: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT} @ ${FPS}fps | ${VIDEO_BITRATE} ${VIDEO_PRESET}/${VIDEO_TUNE}`);
    console.log(`Audio: ${hasAudio ? 'capturado' : 'silencio'}`);

    const args = [
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-framerate', String(FPS),
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', String(AUDIO_SAMPLE_RATE),
        '-ac', String(AUDIO_CHANNELS),
        '-i', 'pipe:3',
        '-c:v', 'libx264',
        '-preset', VIDEO_PRESET,
        '-tune', VIDEO_TUNE,
        '-b:v', VIDEO_BITRATE,
        '-maxrate', VIDEO_MAXRATE,
        '-bufsize', VIDEO_BUFSIZE,
        '-g', String(VIDEO_GOP),
        '-keyint_min', '24',
        '-sc_threshold', '40',
        '-refs', '3',
        '-bf', '2',
        '-s', `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
        '-r', String(FPS),
        '-c:a', 'aac',
        '-b:a', AUDIO_BITRATE,
        '-ar', String(AUDIO_SAMPLE_RATE),
        '-ac', String(AUDIO_CHANNELS),
        '-f', 'mpegts',
        '-muxdelay', '0',
        'pipe:1'
    ];

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
    });

    ffmpeg.on('exit', (code) => {
        console.log(`FFmpeg finalizado (codigo ${code})`);
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
}

async function setupAudioCapture(page) {
    try {
        await page.exposeFunction('__sendAudio', (data) => {
            if (!hasAudio) {
                hasAudio = true;
                console.log('Audio capturado');
            }
            const buf = floatsToPCM(data);
            audioBuffer.push(buf);
            if (audioBuffer.length > 30) audioBuffer.shift();
        });

        const result = await page.evaluate(() => {
            const videos = document.querySelectorAll('video');
            videos.forEach(v => {
                v.muted = false;
                v.volume = 1.0;
                v.autoplay = true;
                v.play().catch(() => {});
            });
            const audios = document.querySelectorAll('audio');
            audios.forEach(a => {
                a.muted = false;
                a.volume = 1.0;
            });

            const video = document.querySelector('video');
            if (!video) return false;

            try {
                const ctx = new AudioContext({ sampleRate: 48000 });
                const source = ctx.createMediaElementSource(video);
                const processor = ctx.createScriptProcessor(2048, 2, 2);
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

        if (!result) {
            console.log('Audio: no disponible (posible CORS). Solo video.');
        }
        return result;
    } catch (err) {
        console.log(`Audio: error de captura - ${err.message}`);
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

    console.log(`Navegador: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`);
    console.log(`URL: ${TARGET_URL}`);

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
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
                '--silent'
            ]
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
            quality: SCREENCAST_QUALITY,
            maxWidth: VIEWPORT_WIDTH,
            maxHeight: VIEWPORT_HEIGHT,
            everyNthFrame: 1
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
        await setupAudioCapture(page);
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
            res.socket.setSendBufferSize(256 * 1024);
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

server.listen(PORT, () => {
    console.log(`Proxy: http://localhost:${PORT}/stream`);
    console.log(`Config: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT} @ ${FPS}fps | ${VIDEO_BITRATE} ${VIDEO_PRESET}/${VIDEO_TUNE}`);
});

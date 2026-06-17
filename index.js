require('dotenv').config();
const { Client } = require('discord.js-selfbot-youtsuho-v13');
const { Streamer, prepareStream, playStream } = require('@dank074/discord-video-stream');
const { spawn } = require('child_process');

const TOKEN = process.env.SELFBOT_TOKEN;
const GUILD_ID = '1515769401461178399';
const VOICE_CHANNEL_ID = '1515772153927303259';
const PROXY_URL = 'http://localhost:8888/stream';

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5000;

if (!TOKEN) {
    console.error("Token no encontrado en .env");
    process.exit(1);
}

const client = new Client({ checkUpdate: false });

async function joinVoiceWithRetry(streamer, channel, attempt = 1) {
    try {
        console.log(`Intento ${attempt}/${MAX_RETRIES} de conexion de voz...`);
        await streamer.joinVoiceChannel(channel);
        console.log("Conexion de voz establecida (WebRTC/UDP)");
    } catch (err) {
        if (attempt < MAX_RETRIES && (err.message.includes("timeout") || err.message.includes("ETIMEDOUT") || err.message.includes("ECONNREFUSED"))) {
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            console.log(`Error: ${err.message}. Reintentando en ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            return joinVoiceWithRetry(streamer, channel, attempt + 1);
        }
        throw err;
    }
}

function setupAudioFallback(streamer, guild) {
    let ffmpegAudio = null;
    try {
        const { createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');

        ffmpegAudio = spawn('ffmpeg', [
            '-re',
            '-i', PROXY_URL,
            '-vn',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-bufsize', '4096',
            'pipe:1'
        ]);

        const audioPlayer = createAudioPlayer();
        const resource = createAudioResource(ffmpegAudio.stdout, {
            inputType: 'raw',
            inlineVolume: true
        });
        resource.volume?.setVolume(1.0);
        audioPlayer.play(resource);

        const voiceConn = streamer.connection || streamer.voiceConnection;
        if (voiceConn) {
            voiceConn.subscribe(audioPlayer);
            console.log('Audio por canal de voz activado (fallback)');
        } else {
            const { joinVoiceChannel } = require('@discordjs/voice');
            const conn = joinVoiceChannel({
                channelId: VOICE_CHANNEL_ID,
                guildId: GUILD_ID,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false,
            });
            conn.subscribe(audioPlayer);
            console.log('Audio por canal de voz activado (nueva conexion)');
        }

        audioPlayer.on(AudioPlayerStatus.Idle, () => {
            console.log('Reproduccion de audio finalizada');
        });
        audioPlayer.on('error', (err) => {
            console.error('Error en reproductor de audio:', err.message);
        });

        ffmpegAudio.stderr.on('data', () => {});
    } catch (e) {
        console.error('Error en fallback de audio:', e.message);
        if (ffmpegAudio) ffmpegAudio.kill();
    }

    return ffmpegAudio;
}

client.once('ready', async () => {
    console.log(`Conectado como ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.error("Guild no encontrado. Verifica GUILD_ID o que el bot este en el servidor.");
        process.exit(1);
    }

    const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);
    if (!channel) {
        console.error("Canal de voz no encontrado. Verifica VOICE_CHANNEL_ID.");
        process.exit(1);
    }

    if (!channel.joinable) {
        console.error("No tienes permisos para unirte a este canal de voz.");
        console.error(`   Permisos del canal: ${channel.permissionsFor(guild.members.me)?.toArray().join(', ') || 'N/A'}`);
        process.exit(1);
    }

    if (channel.members.size >= (channel.userLimit || Infinity)) {
        console.error(`Canal lleno (${channel.members.size}/${channel.userLimit}).`);
        process.exit(1);
    }

    console.log(`Uniendose a ${channel.name}...`);
    console.log(`   Region: ${channel.rtcRegion || guild.region || 'automatica'}`);
    console.log(`   Miembros en canal: ${channel.members.size}`);

    const streamer = new Streamer(client);
    let ffmpegAudioFallback = null;

    process.on('SIGINT', async () => {
        console.log("\nSaliendo...");
        if (ffmpegAudioFallback) ffmpegAudioFallback.kill();
        try { streamer.leaveVoice(); } catch (_) {}
        process.exit(0);
    });

    try {
        await joinVoiceWithRetry(streamer, channel);
        await new Promise(r => setTimeout(r, 2000));

        let output;
        let audioInStream = true;

        try {
            const prep = prepareStream(PROXY_URL, {
                width: 1920,
                height: 1080,
                frameRate: 30,
                bitrateVideo: 2500,
                videoCodec: 'H264',
                audio: true,
                bitrateAudio: 128
            });
            output = prep.output;
        } catch (audioErr) {
            console.log(`Audio en stream no disponible: ${audioErr.message}`);
            console.log('Reintentando sin audio...');
            audioInStream = false;
            try {
                const prep = prepareStream(PROXY_URL, {
                    width: 1920,
                    height: 1080,
                    frameRate: 30,
                    bitrateVideo: 2500,
                    videoCodec: 'H264',
                    audio: false
                });
                output = prep.output;
            } catch (noAudioErr) {
                throw new Error(`Error al preparar stream sin audio: ${noAudioErr.message}`);
            }
        }

        console.log("Lanzando Go Live...");
        await playStream(output, streamer, { type: "go-live" });

        if (!audioInStream) {
            console.log('\nConfigurando reproduccion de audio por canal de voz...');
            ffmpegAudioFallback = setupAudioFallback(streamer, guild);
        }

        console.log(`
╔══════════════════════════════════════════╗
║  GO LIVE ACTIVADO                       ║
║  Conexion: WebRTC/UDP                   ║
║  Audio en stream: ${audioInStream ? 'SI' : 'NO (fallback canal de voz)'}     ║
║  Ctrl+C para detener                    ║
╚══════════════════════════════════════════╝
        `);

    } catch (err) {
        console.error("Error fatal:", err.message);
        console.error("   Stack:", err.stack?.split('\n').slice(0, 3).join('\n'));

        if (err.message.includes("timeout") || err.message.includes("Connection not established")) {
            console.log("\nSOLUCIONES PARA TIMEOUT:");
            console.log("1. Ejecuta este script como Administrador.");
            console.log("2. Desactiva temporalmente el Firewall de Windows.");
            console.log("3. Prueba con otro token de usuario (de una cuenta que si funcione).");
            console.log("4. Cambia la red (usa hotspot de movil) para descartar bloqueo ISP.");
            console.log("5. Verifica que el puerto 443 y 80 esten abiertos (usa telnet o Test-NetConnection).");
            console.log("6. Cambia la region de voz del canal en Discord (ajustes del canal > region).");
        }
        if (ffmpegAudioFallback) ffmpegAudioFallback.kill();
        process.exit(1);
    }
});

client.login(TOKEN);

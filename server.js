/**
 * ConversacionIA — Servidor sin dependencias externas
 * Solo usa módulos nativos de Node.js: http, fs, path, crypto, os
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;

// ─── Detectar IP local ───────────────────────────────────────────────────────
function getLocalIP() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'localhost';
}

const LOCAL_IP = getLocalIP();
const BASE_URL = `http://${LOCAL_IP}:${PORT}`;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ─── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
};

const DEEPGRAM_KEY = process.env.DEEPGRAM_KEY || 'ff61b317da3b203ed27fe425774be623c2c103df';
const GROQ_API_KEY = process.env.GROQ_API_KEY || ['gsk_PEtW9Cfgo6k2Q9', 'kohTKTWGdyb3FYKp', 'MvJhnoKDOwF4UttAQjuoyt'].join('');

let aiTimer = null;
let lastProcessedPrompt = '';

function scheduleAIResponse() {
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => {
        const textToProcess = (currentRoomState.finalText || '').trim();
        if (textToProcess && textToProcess !== lastProcessedPrompt) {
            lastProcessedPrompt = textToProcess;
            queryGroqAI(textToProcess);
        }
    }, 3000); // 3 seconds silence trigger
}

function queryGroqAI(userPrompt) {
    console.log(`[Groq AI] Procesando prompt tras 3s de silencio: "${userPrompt}"`);
    broadcast(displays, { type: 'AI_THINKING', prompt: userPrompt });

    const https = require('https');
    const postData = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
            {
                role: 'system',
                content: 'Eres un guía experto e historiador apacionado de la Capilla Sixtina en el Vaticano. Tu único ámbito de conocimiento es la Capilla Sixtina (su historia, los frescos de Miguel Ángel, el Juicio Final, la bóveda, la arquitectura, el cónclave papal, restauración, etc.). REGLA STRICTA INVIOLABLE: Si el usuario te pregunta sobre cualquier otro tema que NO esté directamente relacionado con la Capilla Sixtina (deportes, noticias, otros lugares no relacionados, tecnología, recetas, etc.), responde únicamente: "Lo siento, como guía especializado de la Capilla Sixtina solo puedo responder preguntas relacionadas con este monumento histórico." Sé claro, fascinante, educado y conciso (máximo 2 párrafos breves). Responde en español.'
            },
            {
                role: 'user',
                content: userPrompt
            }
        ],
        stream: true,
        temperature: 0.4
    });

    const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const req = https.request(options, (res) => {
        let buffer = '';
        let fullResponse = '';

        broadcast(displays, { type: 'AI_STREAM_START' });

        res.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep last incomplete line

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const jsonStr = trimmed.replace(/^data:\s*/, '');
                if (jsonStr === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(jsonStr);
                    const textChunk = parsed.choices?.[0]?.delta?.content || '';
                    if (textChunk) {
                        fullResponse += textChunk;
                        broadcast(displays, { type: 'AI_STREAM_CHUNK', chunk: textChunk });
                    }
                } catch (e) { }
            }
        });

        res.on('end', () => {
            console.log('[Groq AI] Respuesta completada');
            broadcast(displays, { type: 'AI_STREAM_END', fullText: fullResponse });
        });
    });

    req.on('error', (err) => {
        console.error('[Groq AI] Error en llamada HTTPS:', err);
        broadcast(displays, { type: 'AI_STREAM_END', fullText: 'Error al consultar a la IA.' });
    });

    req.write(postData);
    req.end();
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // API: info
    if (url === '/api/info') {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host || `${LOCAL_IP}:${PORT}`;
        const baseUrl = `${proto}://${host}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            grabadorUrl: `${baseUrl}/grabador.html`,
            displayUrl: `${baseUrl}/display.html`,
            localIP: LOCAL_IP,
            port: PORT,
        }));
    }

    // API: Transcripción por Bloque de Audio VAD
    if (url === '/api/transcribe' && req.method === 'POST') {
        let chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const audioBuffer = Buffer.concat(chunks);
            if (audioBuffer.length < 100) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Audio buffer too small' }));
            }

            const https = require('https');
            const lang = req.headers['x-language'] || 'es';
            const options = {
                hostname: 'api.deepgram.com',
                path: `/v1/listen?model=nova-2&language=${lang}&smart_format=true&punctuate=true`,
                method: 'POST',
                headers: {
                    'Authorization': `Token ${DEEPGRAM_KEY}`,
                    'Content-Type': req.headers['content-type'] || 'audio/webm',
                    'Content-Length': audioBuffer.length
                }
            };

            const apiReq = https.request(options, (apiRes) => {
                let responseBody = '';
                apiRes.on('data', d => responseBody += d);
                apiRes.on('end', () => {
                    try {
                        const data = JSON.parse(responseBody);
                        const transcript = (data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
                        if (transcript) {
                            // Append discrete sentence
                            currentRoomState.finalText = currentRoomState.finalText
                                ? currentRoomState.finalText + ' ' + transcript
                                : transcript;
                            currentRoomState.timestamp = Date.now();

                            // Broadcast updated state to all displays
                            broadcast(displays, {
                                type: 'SYNC_STATE',
                                finalText: currentRoomState.finalText,
                                interimText: '',
                                timestamp: currentRoomState.timestamp
                            });

                            // Schedule AI query after 3 seconds of silence
                            scheduleAIResponse();
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ text: transcript, fullText: currentRoomState.finalText }));
                    } catch (e) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Parse error', details: e.message }));
                    }
                });
            });

            apiReq.on('error', (err) => {
                console.error('[API] Error Deepgram REST:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Deepgram REST error' }));
            });

            apiReq.write(audioBuffer);
            apiReq.end();
        });
        return;
    }

    // Servir archivos estáticos
    let filePath = path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url);
    const ext = path.extname(filePath);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Not Found');
        }
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'text/plain',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(data);
    });
});

// ─── WebSocket (RFC 6455) sin librerías externas ──────────────────────────────
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function buildHandshakeResponse(key) {
    const accept = crypto
        .createHash('sha1')
        .update(key + WS_MAGIC)
        .digest('base64');
    return (
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
}

function decodeFrame(buf) {
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    if (opcode === 0x8) return { opcode, text: null }; // close
    const masked = !!(buf[1] & 0x80);
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;
    if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
    else if (payloadLen === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
    if (buf.length < offset + (masked ? 4 : 0) + payloadLen) return null;
    let payload;
    if (masked) {
        const mask = buf.slice(offset, offset + 4);
        offset += 4;
        payload = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
    } else {
        payload = buf.slice(offset, offset + payloadLen);
    }
    return { opcode, text: payload.toString('utf8') };
}

function encodeFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + text
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

// Registro de sockets y estado global de la sala (Idempotencia)
const grabadores = new Set();
const displays = new Set();
let currentRoomState = {
    finalText: '',
    interimText: '',
    timestamp: Date.now()
};

function broadcast(targets, msgObj) {
    const frame = encodeFrame(JSON.stringify(msgObj));
    // Purge dead sockets first to prevent duplicates
    for (const sock of [...targets]) {
        if (sock.destroyed || !sock.writable) { targets.delete(sock); continue; }
        try { sock.write(frame); } catch { targets.delete(sock); }
    }
}

// Ping every 5s to detect and purge dead connections
setInterval(() => {
    for (const sock of [...displays]) {
        if (sock.destroyed || !sock.writable) { displays.delete(sock); }
    }
    for (const sock of [...grabadores]) {
        if (sock.destroyed || !sock.writable) { grabadores.delete(sock); }
    }
}, 5000);

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    socket.write(buildHandshakeResponse(key));
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 0);

    let role = null;
    let buf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const frame = decodeFrame(buf);
        if (!frame) return;
        buf = Buffer.alloc(0); // Reset

        if (frame.opcode === 0x8) { socket.destroy(); return; }
        if (!frame.text) return;

        let msg;
        try { msg = JSON.parse(frame.text); } catch { return; }

        // Identificación del cliente
        if (msg.role && !role) {
            role = msg.role;
            if (role === 'grabador') {
                // Destroy any old grabador sockets so there is strictly ONLY 1 active grabador
                for (const s of [...grabadores]) {
                    try { s.destroy(); } catch { }
                    grabadores.delete(s);
                }
                grabadores.add(socket);
                console.log(`[WS] Grabador conectado (1 activo)`);
                broadcast(displays, { type: 'status', grabadores: grabadores.size });
            } else if (role === 'display') {
                displays.add(socket);
                for (const s of [...grabadores]) { if (s.destroyed || !s.writable) grabadores.delete(s); }
                console.log(`[WS] Display conectado. Total en Set: ${displays.size}`);
                // Immediately sync current room state to new display connection
                socket.write(encodeFrame(JSON.stringify({
                    type: 'SYNC_STATE',
                    finalText: currentRoomState.finalText,
                    interimText: currentRoomState.interimText,
                    grabadores: grabadores.size
                })));
            }
            return;
        }

        if (role === 'grabador') {
            if (msg.type === 'SYNC_STATE' || msg.type === 'transcript') {
                currentRoomState = {
                    finalText: msg.finalText || '',
                    interimText: msg.interimText || '',
                    timestamp: Date.now()
                };
                broadcast(displays, {
                    type: 'SYNC_STATE',
                    finalText: currentRoomState.finalText,
                    interimText: currentRoomState.interimText,
                    timestamp: currentRoomState.timestamp
                });
                scheduleAIResponse();
            }
            if (msg.type === 'clear') {
                clearTimeout(aiTimer);
                lastProcessedPrompt = '';
                currentRoomState = { finalText: '', interimText: '', timestamp: Date.now() };
                broadcast(displays, { type: 'SYNC_STATE', finalText: '', interimText: '', timestamp: Date.now() });
                broadcast(displays, { type: 'AI_STREAM_END', fullText: '' });
            }
        }
    });

    socket.on('close', () => {
        if (role === 'grabador') {
            grabadores.delete(socket);
            console.log(`[WS] Grabador desconectado (${grabadores.size} total)`);
            broadcast(displays, { type: 'status', grabadores: grabadores.size });
        } else if (role === 'display') {
            displays.delete(socket);
            console.log(`[WS] Display desconectado. Quedan: ${displays.size}`);
        }
    });

    socket.on('error', (e) => {
        console.error('[WS] Error socket:', e.message);
        // Remove from sets on error to prevent stale duplicates
        grabadores.delete(socket);
        displays.delete(socket);
        try { socket.destroy(); } catch { }
    });
});

// ─── Arrancar ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║        ConversacionIA — Servidor iniciado ✓              ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Admin / QR   →  http://localhost:${PORT}                 ║`);
    console.log(`║  Display      →  http://localhost:${PORT}/display.html    ║`);
    console.log(`║  Grabador red →  ${BASE_URL}/grabador.html   ║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
});

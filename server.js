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

// Registro de sockets por rol
const grabadores = new Set();
const displays = new Set();

function broadcast(targets, msgObj) {
    const frame = encodeFrame(JSON.stringify(msgObj));
    targets.forEach(sock => {
        if (!sock.destroyed) sock.write(frame);
    });
}

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
        buf = Buffer.alloc(0); // Reset (simple, sin fragmentación)

        if (frame.opcode === 0x8) { socket.destroy(); return; }
        if (!frame.text) return;

        let msg;
        try { msg = JSON.parse(frame.text); } catch { return; }

        // Identificación del cliente
        if (msg.role && !role) {
            role = msg.role;
            if (role === 'grabador') {
                grabadores.add(socket);
                console.log(`[WS] Grabador conectado (${grabadores.size} total)`);
                // Notificar displays
                broadcast(displays, { type: 'status', grabadores: grabadores.size });
            } else if (role === 'display') {
                displays.add(socket);
                console.log(`[WS] Display conectado (${displays.size} total)`);
                socket.write(encodeFrame(JSON.stringify({ type: 'status', grabadores: grabadores.size })));
            }
            return;
        }

        if (role === 'grabador') {
            if (msg.type === 'transcript') {
                broadcast(displays, {
                    type: 'transcript',
                    finalText: msg.finalText || '',
                    interimText: msg.interimText || '',
                    timestamp: Date.now()
                });
            }
            if (msg.type === 'clear') {
                broadcast(displays, { type: 'clear' });
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
            console.log(`[WS] Display desconectado (${displays.size} total)`);
        }
    });

    socket.on('error', (e) => console.error('[WS] Error socket:', e.message));
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

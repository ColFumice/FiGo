/**
 * FiGo WebSocket 中继服务器
 *
 * 功能：房间配对 + 消息中继（不解析游戏协议，仅转发）
 *   房主 → {t:'host'} → 服务器生成 6 位房间码 → {t:'code', code}
 *   好友 → {t:'join', code} → 服务器配对 → 双方收到 {t:'joined'}
 *   任何一方 → 游戏消息 → 服务器原样转发给对方
 *   断开 → 对方收到 {t:'left'}
 *
 * 启动：node relay-server.js  （默认 8080 端口）
 * 公网暴露：npx localtunnel --port 8080 --subdomain figo
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT, maxPayload: 65536 });

/** roomCode → { host: ws, guest: ws|null } */
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 无易混淆字符
function genCode() {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c;
}

function cleanupRoom(code, leavingWs) {
    const room = rooms.get(code);
    if (!room) return;
    const other = room.host === leavingWs ? room.guest : room.host;
    if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ t: 'left' }));
    }
    rooms.delete(code);
}

console.log(`FiGo relay server listening on :${PORT}`);

wss.on('connection', (ws) => {
    let myRoom = null;
    let myRole = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.t === 'host') {
            // 房主创建房间
            if (myRoom) return; // 已在房间中
            let code;
            do { code = genCode(); } while (rooms.has(code));
            rooms.set(code, { host: ws, guest: null });
            myRoom = code;
            myRole = 'host';
            ws.send(JSON.stringify({ t: 'code', code }));
            console.log(`[${new Date().toISOString()}] Room ${code} created`);

        } else if (msg.t === 'join') {
            // 好友加入房间
            if (myRoom) return;
            const code = (msg.code || '').trim().toUpperCase();
            const room = rooms.get(code);
            if (!room) {
                ws.send(JSON.stringify({ t: 'error', msg: '房间不存在，请检查房间码' }));
                return;
            }
            if (room.guest) {
                ws.send(JSON.stringify({ t: 'error', msg: '房间已满' }));
                return;
            }
            room.guest = ws;
            myRoom = code;
            myRole = 'guest';
            // 通知双方
            ws.send(JSON.stringify({ t: 'joined', role: 'guest' }));
            room.host.send(JSON.stringify({ t: 'joined', role: 'host' }));
            console.log(`[${new Date().toISOString()}] Room ${code} paired`);

        } else {
            // 游戏消息：转发给对方
            if (myRoom) {
                const room = rooms.get(myRoom);
                if (room) {
                    const other = myRole === 'host' ? room.guest : room.host;
                    if (other && other.readyState === WebSocket.OPEN) {
                        other.send(raw.toString());
                    }
                }
            }
        }
    });

    ws.on('close', () => {
        if (myRoom) {
            console.log(`[${new Date().toISOString()}] Room ${myRoom} closed (${myRole} left)`);
            cleanupRoom(myRoom, ws);
        }
    });

    ws.on('error', () => {
        if (myRoom) cleanupRoom(myRoom, ws);
    });
});

/**
 * FiGo 联机层：基于 WebSocket 中继服务器的在线对战
 *
 * 替代原 WebRTC 方案（Cocos 原生 JSB 无 RTCPeerConnection）。
 * WebSocket 为 JSB 原生支持，通过中继服务器转发消息，无需 P2P 打洞。
 *
 *   房主：hostCreateRoom() → 连接服务器 → 收到 6 位房间码 → 分享给好友
 *   好友：joinRoom(code) → 连接服务器 → 加入房间 → 双方自动开始对战
 *
 * 服务器仅做消息中继，不解析游戏协议。
 */

export interface NetMsg {
    t: string;
    x?: number;
    y?: number;
}

export type NetState =
    | 'idle'
    | 'connecting'
    | 'hosting'
    | 'joining'
    | 'open'
    | 'closed'
    | 'failed';

// 中继服务器地址（通过 cloudflared 隧道公网暴露）
const SERVER_URL = 'wss://cooperative-contamination-nails-improvement.trycloudflare.com';

export class NetManager {
    role: 'host' | 'guest' | null = null;
    connected = false;

    onState: (s: NetState) => void = () => {};
    onOpen: () => void = () => {};
    onClose: () => void = () => {};
    onMessage: (m: NetMsg) => void = () => {};

    private ws: WebSocket | null = null;

    get supported(): boolean {
        return typeof WebSocket !== 'undefined';
    }

    /** 房主：创建房间，返回 6 位房间码 */
    hostCreateRoom(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.close();
            this.role = 'host';
            this.onState('connecting');

            const ws = new WebSocket(SERVER_URL);
            let settled = false;

            ws.onopen = () => {
                ws.send(JSON.stringify({ t: 'host' }));
            };

            ws.onmessage = (e: MessageEvent) => {
                try {
                    const msg = JSON.parse(e.data as string);
                    if (msg.t === 'code' && msg.code) {
                        this.ws = ws;
                        settled = true;
                        this.onState('hosting');
                        resolve(msg.code as string);
                    } else if (msg.t === 'joined') {
                        this.connected = true;
                        this.onState('open');
                        this.onOpen();
                    } else if (msg.t === 'left') {
                        this.connected = false;
                        this.onState('closed');
                        this.onClose();
                    } else {
                        this.onMessage(msg as NetMsg);
                    }
                } catch {
                    /* 忽略非法消息 */
                }
            };

            ws.onerror = () => {
                if (!settled) {
                    this.role = null;
                    this.onState('failed');
                    reject(new Error('无法连接服务器，请检查网络'));
                }
            };

            ws.onclose = () => {
                if (this.connected) {
                    this.connected = false;
                    this.onState('closed');
                    this.onClose();
                } else if (!settled) {
                    this.role = null;
                    this.onState('failed');
                    reject(new Error('连接已断开'));
                }
            };
        });
    }

    /** 好友：加入房间 */
    joinRoom(code: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.close();
            this.role = 'guest';
            this.onState('connecting');

            const ws = new WebSocket(SERVER_URL);
            let settled = false;

            ws.onopen = () => {
                ws.send(JSON.stringify({ t: 'join', code: code.trim().toUpperCase() }));
            };

            ws.onmessage = (e: MessageEvent) => {
                try {
                    const msg = JSON.parse(e.data as string);
                    if (msg.t === 'joined') {
                        this.ws = ws;
                        this.connected = true;
                        settled = true;
                        this.onState('open');
                        this.onOpen();
                        resolve();
                    } else if (msg.t === 'error') {
                        this.role = null;
                        settled = true;
                        this.onState('failed');
                        reject(new Error(msg.msg || '加入房间失败'));
                    } else if (msg.t === 'left') {
                        this.connected = false;
                        this.onState('closed');
                        this.onClose();
                    } else {
                        this.onMessage(msg as NetMsg);
                    }
                } catch {
                    /* 忽略非法消息 */
                }
            };

            ws.onerror = () => {
                if (!settled) {
                    this.role = null;
                    this.onState('failed');
                    reject(new Error('无法连接服务器，请检查网络'));
                }
            };

            ws.onclose = () => {
                if (this.connected) {
                    this.connected = false;
                    this.onState('closed');
                    this.onClose();
                } else if (!settled) {
                    this.role = null;
                    this.onState('failed');
                    reject(new Error('连接已断开'));
                }
            };
        });
    }

    send(m: NetMsg): void {
        if (this.ws && this.connected) {
            try {
                this.ws.send(JSON.stringify(m));
            } catch {
                /* 发送失败忽略 */
            }
        }
    }

    close(): void {
        try {
            this.ws?.close();
        } catch {
            /* noop */
        }
        this.ws = null;
        this.connected = false;
        this.role = null;
    }
}

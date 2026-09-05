/**
 * FiGo 棋盘核心规则层（纯逻辑，不依赖 Cocos）
 *
 * 玩法融合：
 *  - 围棋：落子后相邻对方棋块「无气」即被提掉；自杀手为禁着点；禁止全局同形再现（劫）。
 *  - 五子棋：落子后己方在横/竖/两条斜线上形成连续 5 子（含）以上即获胜。
 *
 * 棋盘为 size×size 的交叉点数组（默认 15 路），取值见 Cell。
 */

export const Cell = {
    Empty: 0,
    Black: 1,
    White: 2,
} as const;

export type CellValue = (typeof Cell)[keyof typeof Cell];

export interface Point {
    x: number;
    y: number;
}

export interface MoveResult {
    ok: boolean;
    /** 非法原因：'occupied' | 'suicide' | 'ko' | 'out' */
    reason?: string;
    /** 本手提掉的对方棋子 */
    captured: Point[];
    /** 连五获胜时的棋子坐标（>=5），未获胜为空数组 */
    winLine: Point[];
}

interface Group {
    points: Point[];
    liberties: number;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
];

export class BoardLogic {
    readonly size: number;
    data: Uint8Array;
    /** 历史局面快照（用于 positional superko 禁全同） */
    private history: string[] = [];

    constructor(size = 15) {
        this.size = size;
        this.data = new Uint8Array(size * size);
        this.history.push(this.snapshot());
    }

    reset(): void {
        this.data.fill(Cell.Empty);
        this.history.length = 0;
        this.history.push(this.snapshot());
    }

    inBoard(x: number, y: number): boolean {
        return x >= 0 && y >= 0 && x < this.size && y < this.size;
    }

    get(x: number, y: number): number {
        return this.data[y * this.size + x];
    }

    isFull(): boolean {
        for (let i = 0; i < this.data.length; i++) {
            if (this.data[i] === Cell.Empty) return false;
        }
        return true;
    }

    private snapshot(): string {
        return this.data.join(',');
    }

    private restore(s: string): void {
        const parts = s.split(',');
        for (let i = 0; i < parts.length; i++) this.data[i] = parts[i].charCodeAt(0) - 48;
    }

    /**
     * 尝试落子。非法时棋盘状态保持不变。
     */
    place(x: number, y: number, color: number): MoveResult {
        const res: MoveResult = { ok: false, captured: [], winLine: [] };
        if (!this.inBoard(x, y)) {
            res.reason = 'out';
            return res;
        }
        if (this.get(x, y) !== Cell.Empty) {
            res.reason = 'occupied';
            return res;
        }
        if (color !== Cell.Black && color !== Cell.White) {
            res.reason = 'color';
            return res;
        }

        const before = this.snapshot();
        this.data[y * this.size + x] = color;

        // 1) 提子：检查与新子相邻的对方棋块，无气则移除
        const opp = color === Cell.Black ? Cell.White : Cell.Black;
        const seen = new Uint8Array(this.size * this.size);
        const captured: Point[] = [];
        for (const [dx, dy] of DIRS) {
            const nx = x + dx;
            const ny = y + dy;
            if (!this.inBoard(nx, ny) || this.get(nx, ny) !== opp || seen[ny * this.size + nx]) continue;
            const group = this.floodGroup(nx, ny, opp, seen);
            if (group.liberties === 0) {
                for (const p of group.points) {
                    this.data[p.y * this.size + p.x] = Cell.Empty;
                    captured.push(p);
                }
            }
        }

        // 2) 禁着点：落子并提子后，己方棋块仍无气 → 自杀，回滚
        const own = this.floodGroup(x, y, color, new Uint8Array(this.size * this.size));
        if (own.liberties === 0) {
            this.restore(before);
            res.reason = 'suicide';
            return res;
        }

        // 3) 劫（禁全同）：落子后局面曾在历史中出现 → 回滚
        const after = this.snapshot();
        for (let i = 0; i < this.history.length; i++) {
            if (this.history[i] === after) {
                this.restore(before);
                res.reason = 'ko';
                return res;
            }
        }

        // 4) 连五判定：以新子为中心，四方向正反延伸计数
        const winLine = this.checkFive(x, y, color);

        this.history.push(after);
        res.ok = true;
        res.captured = captured;
        res.winLine = winLine;
        return res;
    }

    /** 洪水填充提取棋块，并统计气数（空交叉点去重） */
    private floodGroup(x: number, y: number, color: number, seen: Uint8Array): Group {
        const points: Point[] = [];
        const libSeen = new Uint8Array(this.size * this.size);
        let liberties = 0;
        const stack: Array<[number, number]> = [[x, y]];
        seen[y * this.size + x] = 1;

        while (stack.length > 0) {
            const [cx, cy] = stack.pop()!;
            points.push({ x: cx, y: cy });
            for (const [dx, dy] of DIRS) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (!this.inBoard(nx, ny)) continue;
                const v = this.get(nx, ny);
                const ni = ny * this.size + nx;
                if (v === Cell.Empty) {
                    if (!libSeen[ni]) {
                        libSeen[ni] = 1;
                        liberties++;
                    }
                } else if (v === color && !seen[ni]) {
                    seen[ni] = 1;
                    stack.push([nx, ny]);
                }
            }
        }
        return { points, liberties };
    }

    /** 以 (x,y) 为中心扫描四个方向，返回连成长度 >=5 的那一条线 */
    private checkFive(x: number, y: number, color: number): Point[] {
        const scan: ReadonlyArray<readonly [number, number]> = [
            [1, 0],
            [0, 1],
            [1, 1],
            [1, -1],
        ];
        for (const [dx, dy] of scan) {
            const line: Point[] = [{ x, y }];
            for (let s = 1; s < this.size; s++) {
                const nx = x + dx * s;
                const ny = y + dy * s;
                if (this.inBoard(nx, ny) && this.get(nx, ny) === color) line.push({ x: nx, y: ny });
                else break;
            }
            for (let s = 1; s < this.size; s++) {
                const nx = x - dx * s;
                const ny = y - dy * s;
                if (this.inBoard(nx, ny) && this.get(nx, ny) === color) line.push({ x: nx, y: ny });
                else break;
            }
            if (line.length >= 5) return line;
        }
        return [];
    }
}

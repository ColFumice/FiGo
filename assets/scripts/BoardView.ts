/**
 * FiGo 棋盘表现层：木桌棕底 + 米色棋盘极简风
 *  - 棋盘：米白色圆角面板（比网格略大，左下带阴影），灰色网格，深色星位
 *  - 棋子：黑子深褐、白子米白（纯色无霓虹边框），落子带弹出 + 水波纹扩散
 *  - 最后一手：金色光点；连五胜利：金色圆头亮线
 *
 * 输入链路遵循「触摸点 → UITransform 本地坐标 → 网格坐标」，
 * 全部换算在棋盘节点本地坐标系内完成，避免跨相机坐标系问题。
 */
import {
    _decorator,
    Component,
    Node,
    Graphics,
    UITransform,
    Color,
    Vec3,
    v3,
    tween,
    Layers,
    EventTouch,
} from 'cc';
import { Cell, Point } from './BoardLogic';

const { ccclass } = _decorator;

const COL_BLACK_STONE = new Color(43, 36, 25, 255); // 黑子：深褐近黑
const COL_WHITE_STONE = new Color(246, 238, 219, 255); // 白子：米白
const COL_WHITE_EDGE = new Color(176, 158, 120, 255); // 白子淡边（与米色棋盘区分）
const COL_GOLD = new Color(255, 214, 64, 255);
const COL_GRID = new Color(120, 106, 84, 255); // 网格线：灰褐
const COL_STAR = new Color(94, 75, 46, 255); // 星位：深褐（米白棋盘上白星不可见，用深色）
const COL_PANEL = new Color(214, 196, 156, 255); // 棋盘面板：深米白
const COL_SHADOW = new Color(26, 15, 6, 110); // 面板阴影
const COL_RIPPLE = new Color(122, 88, 44, 255); // 水波纹

/** 3mm / 2mm 圆角（设计单位，约 6 单位/mm） */
const R_PANEL = 18;
const R_GRID = 12;

@ccclass('BoardView')
export class BoardView extends Component {
    private size = 15;
    private boardPx = 660;
    private cell = 40;
    private span = 560;

    private bgG: Graphics = null!;
    private gridG: Graphics = null!;
    private rippleG: Graphics = null!;
    private winNode: Node = null!;
    private winG: Graphics = null!;
    private pieceLayer: Node = null!;
    private lastMark: Node = null!;
    private pieces: (Node | null)[][] = [];

    /** 进行中的水波纹（本地坐标 + 年龄） */
    private ripples: { x: number; y: number; age: number }[] = [];
    private static readonly RIPPLE_DUR = 0.65;

    private interactive = false;
    /** 落子回调（网格坐标），由 FigoGame 注入 */
    onPlace: ((x: number, y: number) => void) | null = null;

    init(size: number): void {
        this.size = size;

        // 渲染层级（自下而上）：面板阴影 → 网格 → 水波纹 → 棋子 → 胜利线 → 最后一手
        // 每个 Graphics 都挂在独立子节点上：同一节点挂多个 Graphics 会互相覆盖
        // 原生端节点停用再启用后 Graphics 几何会丢失，传入重绘回调在重新激活时自动重画
        this.bgG = this.newGfxNode('bg', () => this.drawPanel());
        this.gridG = this.newGfxNode('grid', () => this.drawGrid());
        this.rippleG = this.newGfxNode('ripple', (g) => g.clear());

        this.pieceLayer = new Node('pieces');
        this.pieceLayer.layer = Layers.Enum.UI_2D;
        this.pieceLayer.addComponent(UITransform);
        this.node.addChild(this.pieceLayer);

        // 胜利线画在独立子节点
        this.winNode = new Node('win');
        this.winNode.layer = Layers.Enum.UI_2D;
        this.winNode.addComponent(UITransform);
        this.winG = this.winNode.addComponent(Graphics);
        this.node.addChild(this.winNode);

        // 最后一手金色光点
        this.lastMark = new Node('last');
        this.lastMark.layer = Layers.Enum.UI_2D;
        this.lastMark.addComponent(UITransform);
        const lg = this.lastMark.addComponent(Graphics);
        lg.fillColor = COL_GOLD;
        lg.circle(0, 0, 5);
        lg.fill();
        this.node.addChild(this.lastMark);
        // 自身 active 切换或父面板重新激活后都需重画（原生端 Graphics 几何不自动恢复）
        // ACTIVE_CHANGED 在递归激活时派发到子树每个节点（第二参数为 active）；
        // ACTIVE_IN_HIERARCHY_CHANGED 只从被切换 active 的根节点发出，子节点收不到
        const redrawLast = () => {
            lg.clear();
            lg.fillColor = COL_GOLD;
            lg.circle(0, 0, 5);
            lg.fill();
        };
        this.lastMark.on(Node.EventType.ACTIVE_CHANGED, (_n: Node, active: boolean) => {
            if (active) redrawLast();
        });
        this.lastMark.active = false;

        this.pieces = [];
        for (let y = 0; y < size; y++) {
            this.pieces.push(new Array(size).fill(null));
        }

        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
    }

    /** 创建一个带 UITransform + Graphics 的子节点（按调用顺序决定层级）。
     *  repaint：节点随父面板停用→重新激活时的重绘回调（原生端 Graphics 几何不会自动恢复） */
    private newGfxNode(name: string, repaint?: (g: Graphics) => void): Graphics {
        const n = new Node(name);
        n.layer = Layers.Enum.UI_2D;
        n.addComponent(UITransform);
        const g = n.addComponent(Graphics);
        this.node.addChild(n);
        if (repaint) {
            const doRepaint = () => {
                g.clear();
                repaint(g);
            };
            // ACTIVE_CHANGED 在父面板激活时会派发到子树每个节点（第二参数为 active）
            n.on(Node.EventType.ACTIVE_CHANGED, (_node: Node, active: boolean) => {
                if (active) doRepaint();
            });
        }
        return g;
    }

    /** 根据像素边长重新布局并重绘（旋转屏/窗口变化时调用） */
    resize(boardPx: number, data?: Uint8Array): void {
        this.boardPx = boardPx;
        const margin = boardPx * 0.055;
        this.span = boardPx - margin * 2;
        this.cell = this.span / (this.size - 1);

        const ut = this.node.getComponent(UITransform)!;
        ut.setContentSize(boardPx, boardPx);

        this.ripples = [];
        this.rippleG.clear();
        this.drawPanel();
        this.drawGrid();

        // 依据数据重建棋子位置
        if (data) this.syncFromData(data);
    }

    /** 圆角矩形路径（x,y 为矩形左下角坐标，r 为圆角半径） */
    private roundRectPath(g: Graphics, x: number, y: number, w: number, h: number, r: number): void {
        r = Math.min(r, w / 2, h / 2);
        g.moveTo(x + r, y);
        g.lineTo(x + w - r, y);
        g.quadraticCurveTo(x + w, y, x + w, y + r);
        g.lineTo(x + w, y + h - r);
        g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        g.lineTo(x + r, y + h);
        g.quadraticCurveTo(x, y + h, x, y + h - r);
        g.lineTo(x, y + r);
        g.quadraticCurveTo(x, y, x + r, y);
    }

    /** 棋盘面板：阴影（左下偏移）+ 深米白圆角底，比网格略大 */
    private drawPanel(): void {
        const g = this.bgG;
        g.clear();
        const half = this.span / 2;
        const pad = this.cell * 0.85;
        const s = this.span + pad * 2;
        const x = -half - pad;
        const y = -half - pad;

        g.fillColor = COL_SHADOW;
        this.roundRectPath(g, x - 9, y - 9, s, s, R_PANEL);
        g.fill();

        g.fillColor = COL_PANEL;
        this.roundRectPath(g, x, y, s, s, R_PANEL);
        g.fill();
    }

    private drawGrid(): void {
        const g = this.gridG;
        g.clear();
        const half = this.span / 2;

        // 棋盘线：灰褐单线（内部纵横线）
        g.strokeColor = COL_GRID;
        g.lineWidth = 1.6;
        for (let i = 1; i < this.size - 1; i++) {
            const p = -half + i * this.cell;
            g.moveTo(p, -half);
            g.lineTo(p, half);
            g.moveTo(-half, p);
            g.lineTo(half, p);
        }
        // 外框：2mm 圆角矩形
        this.roundRectPath(g, -half, -half, this.span, this.span, R_GRID);
        g.stroke();

        // 星位（15 路：天元 + 四角星位）：白色
        const stars: Point[] = [
            { x: 3, y: 3 },
            { x: 3, y: 11 },
            { x: 7, y: 7 },
            { x: 11, y: 3 },
            { x: 11, y: 11 },
        ];
        g.fillColor = COL_STAR;
        for (const s of stars) {
            const pos = this.gridToLocal(s.x, s.y);
            g.circle(pos.x, pos.y, s.x === 7 ? 5 : 4);
            g.fill();
        }
    }

    /** 网格坐标 → 棋盘节点本地坐标 */
    gridToLocal(x: number, y: number): Vec3 {
        const half = this.span / 2;
        return v3(-half + x * this.cell, half - y * this.cell, 0);
    }

    /** 棋盘节点本地坐标 → 网格坐标（越界返回 null） */
    private localToGrid(lx: number, ly: number): Point | null {
        const half = this.span / 2;
        const gx = Math.round((lx + half) / this.cell);
        const gy = Math.round((half - ly) / this.cell);
        if (gx < 0 || gy < 0 || gx >= this.size || gy >= this.size) return null;
        const p = this.gridToLocal(gx, gy);
        // 触点离交叉点太远则忽略
        if (Math.abs(p.x - lx) > this.cell * 0.48 || Math.abs(p.y - ly) > this.cell * 0.48) return null;
        return { x: gx, y: gy };
    }

    setInteractive(b: boolean): void {
        this.interactive = b;
    }

    private onTouchEnd(e: EventTouch): void {
        if (!this.interactive || !this.onPlace) return;
        const ui = this.node.getComponent(UITransform)!;
        const loc = e.getUILocation();
        const local = ui.convertToNodeSpaceAR(v3(loc.x, loc.y, 0));
        const grid = this.localToGrid(local.x, local.y);
        if (grid) this.onPlace(grid.x, grid.y);
    }

    /** 放一颗棋子（带弹出动画 + 水波纹扩散） */
    addStone(x: number, y: number, color: number): void {
        const node = this.createStoneNode(x, y, color);
        node.setScale(0, 0, 1);
        tween(node)
            .to(0.18, { scale: v3(1, 1, 1) }, { easing: 'backOut' })
            .start();
        this.pieces[y][x] = node;
        this.spawnRipple(x, y);
    }

    /** 在落子点生成一圈水波纹（双层错峰扩散，粗细流畅衰减） */
    private spawnRipple(x: number, y: number): void {
        const pos = this.gridToLocal(x, y);
        this.ripples.push({ x: pos.x, y: pos.y, age: 0 });
    }

    update(dt: number): void {
        if (this.ripples.length === 0) return;
        const g = this.rippleG;
        g.clear();
        const dur = BoardView.RIPPLE_DUR;
        this.ripples = this.ripples.filter((rp) => {
            rp.age += dt;
            const t = rp.age / dur;
            if (t >= 1) return false;
            // 两圈错峰：每圈半径随时间扩张，线宽与透明度平滑衰减
            for (let k = 0; k < 2; k++) {
                const lt = t * 1.35 - k * 0.22;
                if (lt <= 0 || lt >= 1) continue;
                const ease = 1 - Math.pow(1 - lt, 2); // easeOut，扩散先快后缓
                const rad = this.cell * (0.35 + ease * 4.4);
                const alpha = (1 - lt) * (1 - lt) * 150;
                g.lineWidth = 3.4 * (1 - lt) + 0.5;
                g.strokeColor = new Color(COL_RIPPLE.r, COL_RIPPLE.g, COL_RIPPLE.b, Math.round(alpha));
                g.circle(rp.x, rp.y, rad);
                g.stroke();
            }
            return true;
        });
    }

    private createStoneNode(x: number, y: number, color: number): Node {
        const isBlack = color === Cell.Black;
        const r = this.cell * 0.38; // 棋子缩小

        const node = new Node(isBlack ? 'b' : 'w');
        node.layer = Layers.Enum.UI_2D;
        node.addComponent(UITransform);
        const g = node.addComponent(Graphics);

        // 落子阴影（贴在米色棋盘上的轻微投影）
        g.fillColor = new Color(26, 15, 6, 60);
        g.circle(0, -2, r);
        g.fill();

        // 纯色棋子：黑子深褐、白子米白，无红蓝霓虹边框
        g.fillColor = isBlack ? COL_BLACK_STONE : COL_WHITE_STONE;
        g.circle(0, 0, r);
        g.fill();

        if (!isBlack) {
            // 白子加一圈淡边，与米色棋盘区分
            g.strokeColor = COL_WHITE_EDGE;
            g.lineWidth = 1.8;
            g.circle(0, 0, r);
            g.stroke();
        }

        const pos = this.gridToLocal(x, y);
        node.setPosition(pos);
        this.pieceLayer.addChild(node);
        return node;
    }

    /** 提子动画：缩没后销毁 */
    removeStones(points: Point[]): void {
        for (const p of points) {
            const node = this.pieces[p.y]?.[p.x];
            if (!node) continue;
            this.pieces[p.y][p.x] = null;
            tween(node)
                .to(0.22, { scale: v3(0.01, 0.01, 1) }, { easing: 'quadIn' })
                .call(() => node.destroy())
                .start();
        }
    }

    setLast(x: number, y: number): void {
        const pos = this.gridToLocal(x, y);
        this.lastMark.setPosition(pos);
        this.lastMark.active = true;
    }

    clearLast(): void {
        this.lastMark.active = false;
    }

    /** 连五胜利线 */
    showWinLine(line: Point[]): void {
        if (line.length < 2) return;
        const g = this.winG;
        g.clear();
        const a = this.gridToLocal(line[0].x, line[0].y);
        const b = this.gridToLocal(line[line.length - 1].x, line[line.length - 1].y);
        // 向外延伸一点
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ex = (dx / len) * this.cell * 0.6;
        const ey = (dy / len) * this.cell * 0.6;

        const x1 = a.x - ex, y1 = a.y - ey, x2 = b.x + ex, y2 = b.y + ey;

        // 辉光层 + 圆头
        g.strokeColor = new Color(COL_GOLD.r, COL_GOLD.g, COL_GOLD.b, 60);
        g.fillColor = new Color(COL_GOLD.r, COL_GOLD.g, COL_GOLD.b, 60);
        g.lineWidth = 12;
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.circle(x1, y1, 6);
        g.circle(x2, y2, 6);
        g.fill();

        // 亮线层 + 圆头（两端圆角处理）
        g.strokeColor = COL_GOLD;
        g.fillColor = COL_GOLD;
        g.lineWidth = 4;
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.circle(x1, y1, 2);
        g.circle(x2, y2, 2);
        g.fill();
    }

    clearWinLine(): void {
        this.winG.clear();
    }

    /** 按棋盘数据重建全部棋子（无动画，用于布局变化后恢复） */
    syncFromData(data: Uint8Array): void {
        this.pieceLayer.removeAllChildren();
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                const v = data[y * this.size + x];
                if (v === Cell.Black || v === Cell.White) {
                    this.pieces[y][x] = this.createStoneNode(x, y, v);
                } else {
                    this.pieces[y][x] = null;
                }
            }
        }
    }

    reset(): void {
        this.pieceLayer.removeAllChildren();
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) this.pieces[y][x] = null;
        }
        this.clearLast();
        this.clearWinLine();
    }
}

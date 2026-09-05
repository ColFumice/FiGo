/**
 * FiGo 主入口：五子棋 × 围棋
 *  - 木桌棕底 + 米色圆角棋盘极简风，全部界面由代码生成（Graphics + Label + EditBox）
 *  - 落子音/提子音、水波纹扩散、本地双人 / WebSocket 在线对战
 *  - 在线对战：WebSocket 中继服务器 + 6 位房间码配对
 */
import {
    _decorator,
    Component,
    Node,
    Graphics,
    UITransform,
    Label,
    EditBox,
    Color,
    Vec3,
    v3,
    tween,
    Layers,
    view,
    screen,
    debug,
    AudioSource,
    AudioClip,
    resources,
    LabelOutline,
    ResolutionPolicy,
} from 'cc';
import { BoardLogic, Cell, Point } from './BoardLogic';
import { BoardView } from './BoardView';
import { NetManager, NetMsg, NetState } from './NetManager';

const { ccclass } = _decorator;

const CYAN = new Color(0, 229, 255, 255);
const PINK = new Color(255, 61, 154, 255);
const GOLD = new Color(255, 231, 76, 255);
const WHITE = new Color(245, 240, 228, 255);
const DIM = new Color(228, 214, 190, 255);
const BROWN = new Color(123, 82, 45, 255); // 木桌棕背景
const STONE_BLACK = new Color(43, 36, 25, 255); // 黑子深褐
const STONE_WHITE = new Color(246, 238, 219, 255); // 白子米白
const RED = new Color(235, 74, 64, 255); // 超时红字
const TIMER_TURN = 30; // 每回合倒计时秒数
const TIMER_OVER = 5; // 「时间到」闪烁秒数后跳过回合
const BOARD_SIZE = 15;

type Mode = 'menu' | 'local' | 'online';

@ccclass('FigoGame')
export class FigoGame extends Component {
    private board = new BoardLogic(BOARD_SIZE);
    private net = new NetManager();
    private view: BoardView = null!;

    private mode: Mode = 'menu';
    private current: number = Cell.Black;
    private myColor: number = Cell.Black;
    private gameOver = false;
    private winner: number = 0; // 0=无（和棋/进行中），1=黑，2=白
    private lastMove: Point | null = null;
    private capBlack = 0; // 黑方提子数
    private capWhite = 0;

    // 界面节点
    private menuPanel: Node = null!;
    private gamePanel: Node = null!;
    private netPanel: Node = null!;
    private statusLabel: Label = null!;
    private capLabel: Label = null!;
    private netStatus: Label = null!;
    private myCodeLabel: Label = null!;
    private codeInput: EditBox = null!;
    private btnCopy: Node = null!;
    private btnHost: Node = null!;
    private btnGuest: Node = null!;
    private toastNode: Node = null!;
    private toastLabel: Label = null!;

    /** 标题旁行棋指示棋子：节点 + 画笔 + 是否黑子 */
    private indBlack: { node: Node; g: Graphics; dark: boolean } = null!;
    private indWhite: { node: Node; g: Graphics; dark: boolean } = null!;

    /** 回合倒计时（黑左白右，字幕从屏外滑入） */
    private timerLabelB: Label = null!;
    private timerLabelW: Label = null!;
    private timerNodeB: Node = null!;
    private timerNodeW: Node = null!;
    private timerPhase: 'idle' | 'count' | 'over' = 'idle';
    private timerSide: number = 0;
    private timerLeft = TIMER_TURN;
    private timerOverLeft = 0;
    private timerCb: () => void = () => this.timerTick();
    private flashBox: { a: number } | null = null;
    private flashTween: any = null;
    private slideTweens: Map<Node, any> = new Map();

    private audio: AudioSource = null!;
    private placeClip: AudioClip | null = null;
    private captureClip: AudioClip | null = null;

    private myCode = '';

    /** 设计基准高度（固定），宽度随屏幕宽高比自动伸缩 */
    private static readonly DESIGN_H = 1280;
    /** 当前设计宽度（适配后动态值），用于限制 UI 内容最大宽度 */
    private designW = 720;

    onLoad(): void {
        // 关闭左下角性能统计面板（debug 构建的 profiler），保持画面干净居中
        debug.isShowStats = false;

        // 启动时按实际屏幕尺寸自动适配分辨率（FIXED_HEIGHT：高度恒 1280，宽度随屏比伸缩，画面始终铺满无黑边）
        this.adaptResolution();
        // 窗口尺寸变化（旋转/分屏/折叠屏）时引擎自动重算设计宽度，这里同步棋盘布局
        view.on('canvas-resize', () => this.relayout());

        this.buildBackground();
        this.initAudio();
        this.buildMenu();
        this.buildGame();
        this.buildNetPanel();
        this.buildToast();

        this.net.onState = (s) => this.onNetState(s);
        this.net.onOpen = () => this.onNetOpen();
        this.net.onClose = () => this.onNetClose();
        this.net.onMessage = (m) => this.onNetMessage(m);

        this.showMenu();
        this.relayout();
    }

    start(): void {
        // surface 就绪后再校准一次分辨率与布局（onLoad 时窗口尺寸可能未就绪）
        this.adaptResolution();
        this.relayout();
    }

    /** 依据实际窗口尺寸自动适配设计分辨率：高度基准 1280，宽度 = 1280 × 屏幕宽高比 */
    private adaptResolution(): void {
        const win = screen.windowSize;
        if (!win || win.width <= 0 || win.height <= 0) return;
        // 不管横竖屏，都以「较短边对齐设计高度」的方式换算，保证内容完整铺满
        const portrait = win.height >= win.width;
        const scale = (portrait ? win.height : win.width) / FigoGame.DESIGN_H;
        const designW = Math.max(360, Math.round((portrait ? win.width : win.height) / scale));
        this.designW = designW;
        view.setDesignResolutionSize(designW, FigoGame.DESIGN_H, ResolutionPolicy.FIXED_HEIGHT);
    }

    // ---------------- UI 构建 ----------------

    /** UI 内容最大宽度：跟随设计宽度自适应，窄屏设备不溢出 */
    private get uiW(): number {
        return Math.min(660, this.designW - 40);
    }

    /** 木桌棕色全屏背景 */
    private buildBackground(): void {
        const n = this.mkNode(this.node, 'table', 40, 40);
        n.setSiblingIndex(0);
        const g = n.addComponent(Graphics);
        g.fillColor = BROWN;
        g.rect(-2000, -2000, 4000, 4000);
        g.fill();
    }

    /** 预加载落子/提子音效（resources/audio 下的 WAV） */
    private initAudio(): void {
        this.audio = this.node.addComponent(AudioSource);
        resources.load('audio/place', AudioClip, (err, clip) => {
            if (!err) this.placeClip = clip;
        });
        resources.load('audio/capture', AudioClip, (err, clip) => {
            if (!err) this.captureClip = clip;
        });
    }

    private playPlaceSound(): void {
        if (this.placeClip) this.audio.playOneShot(this.placeClip, 1);
    }

    private playCaptureSound(): void {
        if (this.captureClip) this.audio.playOneShot(this.captureClip, 1.1);
    }

    /** Graphics 圆角矩形路径（x,y 为左下角，r 为圆角半径） */
    private roundRect(g: Graphics, x: number, y: number, w: number, h: number, r: number): void {
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

    private mkNode(parent: Node, name: string, w: number, h: number): Node {
        const n = new Node(name);
        n.layer = Layers.Enum.UI_2D;
        const ut = n.addComponent(UITransform);
        ut.setContentSize(w, h);
        parent.addChild(n);
        return n;
    }

    /**
     * 创建随面板隐藏后能自动恢复的 Graphics：原生端（Android）Graphics 的几何数据
     * 只在 fill()/stroke() 时上传，节点经历 停用→启用 后原生绘制数据会被清空且不会自动重发，
     * 因此监听节点激活事件，在每次重新激活时按 draw 回调重绘（Label 不受此问题影响）。
     * 注意：ACTIVE_IN_HIERARCHY_CHANGED 仅从被切换 active 的根节点发出，子节点收不到；
     * ACTIVE_CHANGED 会在递归激活/停用时派发到子树每个节点（回调第二个参数为 active）。
     */
    private persistGfx(node: Node, draw: (g: Graphics) => void): Graphics {
        const g = node.addComponent(Graphics);
        const repaint = () => {
            g.clear();
            draw(g);
        };
        repaint();
        node.on(Node.EventType.ACTIVE_CHANGED, (_n: Node, active: boolean) => {
            if (active) repaint();
        });
        return g;
    }

    private mkLabel(
        parent: Node,
        text: string,
        fontSize: number,
        color: Color,
        x: number,
        y: number,
        w: number,
        h: number,
        align: Label.HorizontalAlign = Label.HorizontalAlign.CENTER,
    ): Label {
        const n = this.mkNode(parent, 'lb', w, h);
        n.setPosition(x, y);
        const l = n.addComponent(Label);
        l.useSystemFont = true;
        l.string = text;
        l.fontSize = fontSize;
        l.lineHeight = Math.round(fontSize * 1.35);
        l.color = color;
        l.horizontalAlign = align;
        l.verticalAlign = Label.VerticalAlign.CENTER;
        l.overflow = Label.Overflow.CLAMP;
        return l;
    }

    private mkButton(
        parent: Node,
        text: string,
        x: number,
        y: number,
        w: number,
        h: number,
        accent: Color,
        cb: () => void,
        fontSize = 30,
        textColor: Color = WHITE,
        alpha = 1,
    ): Node {
        const n = this.mkNode(parent, 'btn-' + text, w, h);
        n.setPosition(x, y);
        const aStroke = Math.round(255 * alpha);
        const fillC = new Color(accent.r, accent.g, accent.b, Math.round(26 * alpha));
        const strokeC = new Color(WHITE.r, WHITE.g, WHITE.b, aStroke);
        const rad = Math.min(18, h * 0.3);
        // 填充保留淡色底；边框白色（随面板隐藏后由 persistGfx 自动重绘）
        this.persistGfx(n, (g) => {
            g.fillColor = fillC;
            g.strokeColor = strokeC;
            g.lineWidth = 2.5;
            // 3mm 圆角
            this.roundRect(g, -w / 2, -h / 2, w, h, rad);
            g.fill();
            g.stroke();
        });

        // 文字默认白色（如「再来一局」可单独传金色），同步透明度
        const lb = this.mkLabel(n, text, fontSize, new Color(textColor.r, textColor.g, textColor.b, aStroke), 0, 0, w * 0.94, h);
        lb.isBold = true;

        n.on(Node.EventType.TOUCH_START, () => {
            tween(n).to(0.07, { scale: v3(0.95, 0.95, 1) }).start();
        });
        n.on(Node.EventType.TOUCH_CANCEL, () => {
            tween(n).to(0.1, { scale: v3(1, 1, 1) }).start();
        });
        n.on(Node.EventType.TOUCH_END, () => {
            tween(n).to(0.1, { scale: v3(1, 1, 1) }).start();
            cb();
        });
        return n;
    }

    /** 创建标题旁的行棋指示棋子（实心圆，与棋盘棋子同色） */
    private mkTurnStone(parent: Node, color: number, x: number, y: number): { node: Node; g: Graphics; dark: boolean } {
        const r = 30;
        const n = this.mkNode(parent, 'ind-' + (color === Cell.Black ? 'b' : 'w'), r * 2, r * 2);
        n.setPosition(x, y);
        const g = n.addComponent(Graphics);
        const dark = color === Cell.Black;
        n.setScale(0.78, 0.78, 1);
        // 初始为非激活态（缩小、30% 透明），由 updateTurnIndicator 刷新
        this.drawTurnStone(g, dark, 0.3);
        return { node: n, g, dark };
    }

    /** 按 alphaRatio（0~1）重绘指示棋子：放大不透明 / 缩小 30% 透明 */
    private drawTurnStone(g: Graphics, dark: boolean, ratio: number): void {
        const r = 30;
        const a = Math.round(255 * ratio);
        g.clear();
        // 轻微投影
        g.fillColor = new Color(26, 15, 6, Math.round(70 * ratio));
        g.circle(0, -2, r);
        g.fill();
        if (dark) {
            g.fillColor = new Color(STONE_BLACK.r, STONE_BLACK.g, STONE_BLACK.b, a);
            g.circle(0, 0, r);
            g.fill();
        } else {
            g.fillColor = new Color(STONE_WHITE.r, STONE_WHITE.g, STONE_WHITE.b, a);
            g.circle(0, 0, r);
            g.fill();
        }
    }

    /** 根据当前行棋方刷新指示棋子：当前方放大不透明，另一方缩小且 30% 透明 */
    private updateTurnIndicator(): void {
        const blackTurn = !this.gameOver && this.current === Cell.Black;
        const whiteTurn = !this.gameOver && this.current === Cell.White;
        this.setTurnStone(this.indBlack, blackTurn);
        this.setTurnStone(this.indWhite, whiteTurn);
    }

    private setTurnStone(ind: { node: Node; g: Graphics; dark: boolean } | null, active: boolean): void {
        if (!ind) return;
        tween(ind.node)
            .to(0.25, { scale: active ? v3(1.3, 1.3, 1) : v3(0.78, 0.78, 1) }, { easing: 'backOut' })
            .start();
        // 透明度用 Graphics 颜色 alpha 渐变重绘（不使用 UIOpacity，避免与 Graphics 渲染冲突）
        const st = { ratio: active ? 0.3 : 1 };
        tween(st)
            .to(
                0.25,
                { ratio: active ? 1 : 0.3 },
                { onUpdate: () => this.drawTurnStone(ind.g, ind.dark, st.ratio) },
            )
            .start();
    }

    /** 标题配色：黑方深字浅边、白方浅字深边 */
    private setStatusTint(isBlack: boolean): void {
        this.statusLabel.color = isBlack ? STONE_BLACK : STONE_WHITE;
        const ol = this.statusLabel.node.getComponent(LabelOutline)!;
        ol.color = isBlack ? new Color(STONE_WHITE.r, STONE_WHITE.g, STONE_WHITE.b, 225) : new Color(STONE_BLACK.r, STONE_BLACK.g, STONE_BLACK.b, 225);
    }

    // ---------------- 回合倒计时 ----------------

    /** 根据当前行棋方同步倒计时（同方回合进行中不重置）；游戏结束则停止并滑出 */
    private syncTimer(): void {
        if (this.gameOver) {
            this.stopTimer();
            return;
        }
        const side = this.current;
        if (this.timerPhase !== 'idle' && this.timerSide === side) return;
        this.unschedule(this.timerCb);
        if (this.flashTween) {
            this.flashTween.stop();
            this.flashTween = null;
            this.flashBox = null;
        }
        this.timerSide = side;
        this.timerPhase = 'count';
        this.timerLeft = TIMER_TURN;
        // 先重置文字/颜色，避免滑入过程中露出上回合的「时间到！」残字
        this.refreshTimerText();
        // 当前方字幕从屏外滑入，另一方原路滑出到屏外
        this.slideTimer(this.timerNodeB, side === Cell.Black, -290, -520);
        this.slideTimer(this.timerNodeW, side === Cell.White, 290, 520);
        this.schedule(this.timerCb, 0.2);
    }

    /** show=true：从屏外滑入；show=false：若在屏内则原路滑出，否则直接放屏外 */
    private slideTimer(node: Node, show: boolean, restX: number, offX: number): void {
        const old = this.slideTweens.get(node);
        if (old) {
            old.stop();
            this.slideTweens.delete(node);
        }
        const y = node.position.y;
        if (show) {
            node.setPosition(offX, y, 0);
            const tw = tween(node).to(0.35, { position: v3(restX, y, 0) }, { easing: 'quadOut' }).start();
            this.slideTweens.set(node, tw);
        } else if (Math.abs(node.position.x - restX) < 80) {
            const tw = tween(node).to(0.3, { position: v3(offX, y, 0) }, { easing: 'quadIn' }).start();
            this.slideTweens.set(node, tw);
        } else {
            node.setPosition(offX, y, 0);
        }
    }

    private stopTimer(): void {
        this.unschedule(this.timerCb);
        this.timerPhase = 'idle';
        this.timerSide = 0;
        if (this.flashTween) {
            this.flashTween.stop();
            this.flashTween = null;
            this.flashBox = null;
        }
        this.slideTimer(this.timerNodeB, false, -290, -520);
        this.slideTimer(this.timerNodeW, false, 290, 520);
    }

    private timerTick(): void {
        if (this.gameOver || this.timerPhase === 'idle') return;
        if (this.timerPhase === 'count') {
            this.timerLeft -= 0.2;
            if (this.timerLeft <= 0) {
                this.timerPhase = 'over';
                this.timerOverLeft = TIMER_OVER;
                this.beginTimeoutFlash();
            }
            this.refreshTimerText();
        } else {
            this.timerOverLeft -= 0.2;
            if (this.timerOverLeft <= 0) this.skipTurnOnTimeout();
        }
    }

    private activeTimerLabel(): Label {
        return this.timerSide === Cell.Black ? this.timerLabelB : this.timerLabelW;
    }

    private refreshTimerText(): void {
        const lb = this.activeTimerLabel();
        if (this.timerPhase === 'over') {
            lb.string = '时间到！';
            lb.color = RED;
        } else {
            lb.string = Math.ceil(this.timerLeft) + '秒';
            lb.color = WHITE;
        }
    }

    /** 红字「时间到！」闪烁 5 秒（用颜色 alpha 渐变驱动，避免 UIOpacity 与渲染冲突） */
    private beginTimeoutFlash(): void {
        const lb = this.activeTimerLabel();
        lb.string = '时间到！';
        if (this.flashTween) {
            this.flashTween.stop();
            this.flashTween = null;
        }
        const box = { a: 255 };
        this.flashBox = box;
        const apply = () => {
            lb.color = new Color(RED.r, RED.g, RED.b, Math.round(box.a));
        };
        this.flashTween = tween(box)
            .repeat(10, tween(box).to(0.25, { a: 70 }, { onUpdate: apply }).to(0.25, { a: 255 }, { onUpdate: apply }))
            .start();
    }

    /** 超时处理：红字闪烁 5 秒后跳过本回合（不落子直接换手） */
    private skipTurnOnTimeout(): void {
        this.unschedule(this.timerCb);
        if (this.flashTween) {
            this.flashTween.stop();
            this.flashTween = null;
            this.flashBox = null;
        }
        this.current = this.oppOf(this.current);
        if (this.mode === 'online') {
            this.view.setInteractive(!this.gameOver && this.current === this.myColor);
        }
        this.updateStatus();
    }

    private buildMenu(): void {
        const p = this.mkNode(this.node, 'menu', 720, 1280);

        const title = this.mkLabel(p, 'FiGo', 150, WHITE, 0, 360, 600, 200);
        title.isBold = true;
        this.mkLabel(p, '五子连线 · 围而提之', 38, WHITE, 0, 215, this.uiW, 60);

        this.mkButton(p, '本地双人', 0, 30, 440, 100, CYAN, () => this.startLocal(), 36);
        this.mkButton(p, '在线对战', 0, -105, 440, 100, PINK, () => this.showNetPanel(), 36);

        this.mkLabel(p, '连五即胜  ·  无气提子  ·  禁自杀  ·  禁劫', 24, DIM, 0, -240, 660, 40);
        this.mkLabel(
            p,
            '联机基于 WebSocket 中继服务器，6 位房间码配对，无需 P2P 打洞',
            20,
            new Color(100, 118, 138, 255),
            0,
            -310,
            660,
            40,
        );
        this.menuPanel = p;
    }

    private buildGame(): void {
        const p = this.mkNode(this.node, 'game', 720, 1280);

        this.statusLabel = this.mkLabel(p, '', 38, WHITE, 0, 545, this.uiW, 60);
        this.statusLabel.isBold = true;
        // 标题描边：深色字配浅边 / 浅色字配深边，保证在棕底上可读
        const outline = this.statusLabel.node.addComponent(LabelOutline);
        outline.width = 4;

        // 标题左右的行棋指示棋子：当前方放大、另一方缩小并 30% 透明
        const stoneX = Math.min(250, this.designW / 2 - 80);
        this.indBlack = this.mkTurnStone(p, Cell.Black, -stoneX, 545);
        this.indWhite = this.mkTurnStone(p, Cell.White, stoneX, 545);

        // 文字按钮：下移一个汉字高度（≈30），整体 50% 透明，弱化常驻操作入口
        this.mkButton(p, '返回菜单', -185, 415, 210, 78, DIM, () => this.backToMenu(), 28, WHITE, 0.5);
        this.mkButton(p, '再来一局', 185, 415, 210, 78, GOLD, () => this.restart(), 28, GOLD, 0.5);

        const boardNode = this.mkNode(p, 'board', 660, 660);
        boardNode.setPosition(0, 0);
        this.view = boardNode.addComponent(BoardView);
        this.view.init(BOARD_SIZE);
        this.view.onPlace = (x, y) => this.userPlace(x, y);

        this.capLabel = this.mkLabel(p, '', 24, DIM, 0, -480, 660, 40);

        // 回合倒计时字幕：黑在左、白在右，初始停在屏幕外，回合开始时滑入
        this.timerLabelB = this.mkLabel(p, '', 28, WHITE, -520, -480, 200, 44);
        this.timerLabelB.isBold = true;
        this.timerNodeB = this.timerLabelB.node;
        this.timerLabelW = this.mkLabel(p, '', 28, WHITE, 520, -480, 200, 44);
        this.timerLabelW.isBold = true;
        this.timerNodeW = this.timerLabelW.node;

        this.gamePanel = p;
    }

    private buildNetPanel(): void {
        const p = this.mkNode(this.node, 'net', 720, 1280);

        const title = this.mkLabel(p, '在线对战', 56, WHITE, 0, 555, this.uiW, 80);
        title.isBold = true;

        this.netStatus = this.mkLabel(
            p,
            '',
            26,
            WHITE,
            0,
            450,
            660,
            150,
            Label.HorizontalAlign.CENTER,
        );
        this.netStatus.verticalAlign = Label.VerticalAlign.TOP;
        this.netStatus.overflow = Label.Overflow.RESIZE_HEIGHT;

        this.myCodeLabel = this.mkLabel(
            p,
            '',
            18,
            CYAN,
            0,
            320,
            this.uiW,
            50,
            Label.HorizontalAlign.CENTER,
        );
        this.myCodeLabel.node.active = false;

        this.btnCopy = this.mkButton(p, '复制我的连接码', 0, 245, 440, 80, CYAN, () => this.copyMyCode(), 28);

        this.mkLabel(p, '输入房间码：', 24, DIM, 0, 165, 660, 36);

        // 输入框
        const inputNode = this.mkNode(p, 'code-input', 660, 100);
        inputNode.setPosition(0, 90);
        // 背景必须放在独立子节点：EditBox 在 onEnable 时会自动给【自身所在节点】
        // addComponent(Sprite)，Sprite 的 RenderEntity 会抢占该节点的 userData，
        // 同节点 Graphics 的原生 proxy 随后误读 Sprite 的静态实体为动态 vector 导致原生崩溃。
        const bgNode = this.mkNode(inputNode, 'code-bg', 660, 100);
        this.persistGfx(bgNode, (g) => {
            g.fillColor = new Color(0, 24, 36, 150);
            g.strokeColor = new Color(CYAN.r, CYAN.g, CYAN.b, 170);
            g.lineWidth = 2;
            g.rect(-330, -50, 660, 100);
            g.fill();
            g.stroke();
        });

        const textNode = this.mkNode(inputNode, 'eb-text', 620, 80);
        const tl = textNode.addComponent(Label);
        tl.useSystemFont = true;
        tl.fontSize = 18;
        tl.lineHeight = 24;
        tl.color = WHITE;
        tl.horizontalAlign = Label.HorizontalAlign.LEFT;
        tl.verticalAlign = Label.VerticalAlign.CENTER;
        tl.overflow = Label.Overflow.CLAMP;
        tl.string = '';

        const phNode = this.mkNode(inputNode, 'eb-ph', 620, 80);
        const pl = phNode.addComponent(Label);
        pl.useSystemFont = true;
        pl.fontSize = 20;
        pl.color = new Color(110, 130, 150, 255);
        pl.horizontalAlign = Label.HorizontalAlign.LEFT;
        pl.verticalAlign = Label.VerticalAlign.CENTER;
        pl.overflow = Label.Overflow.CLAMP;
        pl.string = '输入房主发来的 6 位房间码…';

        this.codeInput = inputNode.addComponent(EditBox);
        this.codeInput.textLabel = tl;
        this.codeInput.placeholderLabel = pl;
        this.codeInput.maxLength = 500000;
        this.codeInput.string = '';

        this.mkButton(p, '粘贴剪贴板', 0, -20, 280, 66, DIM, () => this.pasteFromClipboard(), 24);

        this.btnHost = this.mkButton(
            p,
            '创建房间',
            0,
            -140,
            Math.min(540, this.uiW),
            92,
            CYAN,
            () => this.doHost(),
            30,
        );
        this.btnGuest = this.mkButton(
            p,
            '加入房间',
            0,
            -260,
            Math.min(540, this.uiW),
            92,
            PINK,
            () => this.doGuest(),
            30,
        );

        this.mkLabel(
            p,
            '房主点「创建房间」获得 6 位房间码 → 发给好友 → 好友输入房间码点「加入房间」即可开始对战',
            20,
            new Color(100, 118, 138, 255),
            0,
            -440,
            this.uiW,
            60,
        );
        this.mkButton(p, '返回菜单', 0, -530, 320, 76, DIM, () => this.backToMenu(), 26);

        this.netPanel = p;
    }

    private buildToast(): void {
        const n = this.mkNode(this.node, 'toast', this.uiW, 72);
        n.setPosition(0, -560);
        this.persistGfx(n, (g) => {
            g.fillColor = new Color(0, 0, 0, 210);
            g.strokeColor = new Color(CYAN.r, CYAN.g, CYAN.b, 200);
            g.lineWidth = 2;
            g.rect(-this.uiW / 2, -36, this.uiW, 72);
            g.fill();
            g.stroke();
        });
        this.toastLabel = this.mkLabel(n, '', 26, WHITE, 0, 0, this.uiW - 40, 60);
        n.active = false;
        this.toastNode = n;
    }

    private showToast(msg: string): void {
        this.toastLabel.string = msg;
        this.toastNode.active = true;
        this.unschedule(this.hideToast);
        this.scheduleOnce(this.hideToast, 2.0);
    }

    private hideToast(): void {
        this.toastNode.active = false;
    }

    // ---------------- 界面切换 / 布局 ----------------

    private showMenu(): void {
        this.mode = 'menu';
        this.menuPanel.active = true;
        this.gamePanel.active = false;
        this.netPanel.active = false;
    }

    private showNetPanel(): void {
        this.mode = 'menu';
        this.menuPanel.active = false;
        this.gamePanel.active = false;
        this.netPanel.active = true;
        this.resetNetUI();
    }

    private backToMenu(): void {
        this.stopTimer();
        this.net.close();
        this.showMenu();
    }

    private resetNetUI(): void {
        this.myCode = '';
        this.codeInput.string = '';
        this.myCodeLabel.node.active = false;
        this.btnCopy.active = false;
        this.btnHost.active = true;
        this.btnGuest.active = true;
        this.netStatus.string =
            '房主点「创建房间」获得 6 位房间码，发给好友；\n好友输入房间码后点「加入房间」即可开始对战。';
    }

    private relayout(): void {
        const ut = this.node.getComponent(UITransform)!;
        const size = ut.contentSize;
        // 棋盘居中：留出顶部按钮区（≈460）与底部提子计数区，避免重叠
        const boardPx = Math.max(260, Math.min(size.width - 48, size.height - 500));
        const boardNode = this.view.node;
        boardNode.setPosition(0, 0);
        this.view.resize(boardPx, this.board.data);
        if (this.lastMove) this.view.setLast(this.lastMove.x, this.lastMove.y);
    }

    // ---------------- 游戏流程 ----------------

    private startLocal(): void {
        this.mode = 'local';
        this.menuPanel.active = false;
        this.gamePanel.active = true;
        this.netPanel.active = false;
        this.resetGame();
    }

    private resetGame(): void {
        this.board.reset();
        this.view.reset();
        this.current = Cell.Black;
        this.gameOver = false;
        this.winner = 0;
        this.lastMove = null;
        this.capBlack = 0;
        this.capWhite = 0;
        const canTouch = this.mode === 'local' || (this.mode === 'online' && this.myColor === Cell.Black);
        this.view.setInteractive(canTouch);
        this.updateStatus();
    }

    private restart(): void {
        if (this.mode === 'online' && this.net.connected) {
            this.net.send({ t: 'restart' });
        }
        this.resetGame();
        this.showToast('新对局开始，黑方先行');
    }

    private oppOf(c: number): number {
        return c === Cell.Black ? Cell.White : Cell.Black;
    }

    private userPlace(x: number, y: number): void {
        if (this.gameOver) return;
        if (this.mode === 'online' && this.current !== this.myColor) return;
        const color = this.current;
        if (this.applyMove(x, y, color, false)) {
            if (this.mode === 'online') this.net.send({ t: 'move', x, y });
        }
    }

    /** 应用一步棋（本地或远端），返回是否合法生效 */
    private applyMove(x: number, y: number, color: number, remote: boolean): boolean {
        const res = this.board.place(x, y, color);
        if (!res.ok) {
            if (!remote) {
                const reason =
                    res.reason === 'suicide'
                        ? '禁着点：落子后这块棋没有气'
                        : res.reason === 'ko'
                          ? '劫：不能立刻回提，先在别处落子'
                          : '这里已经有棋子了';
                this.showToast(reason);
            }
            return false;
        }

        this.view.addStone(x, y, color);
        this.playPlaceSound();
        if (res.captured.length > 0) {
            this.view.removeStones(res.captured);
            this.playCaptureSound();
            if (color === Cell.Black) this.capBlack += res.captured.length;
            else this.capWhite += res.captured.length;
            if (!remote) this.showToast(`提掉对方 ${res.captured.length} 子！`);
        }
        this.lastMove = { x, y };
        this.view.setLast(x, y);

        if (res.winLine.length >= 5) {
            this.gameOver = true;
            this.winner = color;
            this.view.setInteractive(false);
            this.view.showWinLine(res.winLine);
        } else {
            this.current = this.oppOf(color);
            if (this.board.isFull()) {
                this.gameOver = true;
                this.winner = 0; // 棋盘下满无人连五 → 和棋
                this.view.setInteractive(false);
            }
        }

        if (this.mode === 'online') {
            this.view.setInteractive(!this.gameOver && this.current === this.myColor);
        }
        this.updateStatus();
        return true;
    }

    private updateStatus(): void {
        const nameOf = (c: number) => (c === Cell.Black ? '黑方' : '白方');
        if (this.gameOver) {
            if (this.winner === 0) {
                this.statusLabel.string = '和棋';
                this.statusLabel.color = WHITE;
            } else {
                const winColor = this.winner;
                if (this.mode === 'online') {
                    const youWin = winColor === this.myColor;
                    this.statusLabel.string = youWin ? '连五！你赢了 🎉' : '对方连五，你输了';
                    this.statusLabel.color = youWin ? GOLD : WHITE;
                } else {
                    this.statusLabel.string = nameOf(winColor) + ' 连五获胜！';
                    this.statusLabel.color = GOLD;
                }
            }
            // 结束态标题统一加深色描边，金色/白字在棕底上更清晰
            const ol = this.statusLabel.node.getComponent(LabelOutline);
            if (ol) ol.color = new Color(STONE_BLACK.r, STONE_BLACK.g, STONE_BLACK.b, 200);
        } else if (this.mode === 'online') {
            if (this.current === this.myColor) {
                this.statusLabel.string = '轮到你落子';
                this.setStatusTint(this.current === Cell.Black);
            } else {
                this.statusLabel.string = '等待对方落子…';
                this.statusLabel.color = DIM;
                const ol = this.statusLabel.node.getComponent(LabelOutline)!;
                ol.color = new Color(STONE_BLACK.r, STONE_BLACK.g, STONE_BLACK.b, 200);
            }
        } else {
            this.statusLabel.string = nameOf(this.current) + ' 行棋';
            // 标题颜色跟随当前行棋方（黑子深字浅边 / 白子浅字深边）
            this.setStatusTint(this.current === Cell.Black);
        }
        this.updateTurnIndicator();
        this.syncTimer();
        this.capLabel.string = `提子 —— 黑 ${this.capBlack}  ·  白 ${this.capWhite}`;
    }

    // ---------------- 联机流程 ----------------

    private setNetStatus(s: string): void {
        this.netStatus.string = s;
    }

    private async doHost(): Promise<void> {
        try {
            this.btnHost.active = false;
            this.btnGuest.active = false;
            this.setNetStatus('正在创建房间…');
            const code = await this.net.hostCreateRoom();
            this.myCode = code;
            this.myCodeLabel.string = '房间码：' + code;
            this.myCodeLabel.node.active = true;
            this.btnCopy.active = true;
            this.setNetStatus('房间已创建！把房间码「' + code + '」发给好友，等待加入…');
        } catch (e: any) {
            this.setNetStatus('创建失败：' + (e?.message || e));
            this.btnHost.active = true;
            this.btnGuest.active = true;
        }
    }

    private async doGuest(): Promise<void> {
        try {
            this.btnHost.active = false;
            this.btnGuest.active = false;
            this.setNetStatus('正在加入房间…');
            await this.net.joinRoom(this.codeInput.string);
        } catch (e: any) {
            this.setNetStatus('加入失败：' + (e?.message || e));
            this.btnHost.active = true;
            this.btnGuest.active = true;
        }
    }

    private async copyMyCode(): Promise<void> {
        if (!this.myCode) return;
        const ok = await this.copyText(this.myCode);
        this.showToast(ok ? '已复制！去微信 / QQ 发给好友吧' : '复制失败，请长按文字手动选择复制');
    }

    private async pasteFromClipboard(): Promise<void> {
        const text = await this.readClipboard();
        if (text) {
            this.codeInput.string = text.trim();
            this.showToast('已粘贴');
        } else {
            this.showToast('请长按输入框手动粘贴');
        }
    }

    private onNetState(s: NetState): void {
        if (s === 'failed') {
            this.setNetStatus('连接失败，请返回后重试');
            if (this.gamePanel.active) this.showToast('连接失败');
        } else if (s === 'closed') {
            if (this.mode === 'online') {
                this.statusLabel.string = '连接已断开';
                this.statusLabel.color = DIM;
                this.view.setInteractive(false);
                this.showToast('对方已断开连接');
            }
        }
    }

    private onNetOpen(): void {
        this.mode = 'online';
        this.myColor = this.net.role === 'host' ? Cell.Black : Cell.White;
        this.menuPanel.active = false;
        this.netPanel.active = false;
        this.gamePanel.active = true;
        this.resetGame();
        this.showToast(this.net.role === 'host' ? '好友已加入，你是黑方先行' : '已连接，你是白方');
    }

    private onNetClose(): void {
        // 状态展示由 onNetState 处理
    }

    private onNetMessage(m: NetMsg): void {
        if (m.t === 'move' && typeof m.x === 'number' && typeof m.y === 'number') {
            this.applyMove(m.x, m.y, this.current, true);
        } else if (m.t === 'restart') {
            this.resetGame();
            this.showToast('对方发起了新对局');
        }
    }

    // ---------------- 剪贴板（浏览器环境） ----------------

    private async copyText(s: string): Promise<boolean> {
        const g = globalThis as any;
        try {
            if (g.navigator?.clipboard?.writeText) {
                await g.navigator.clipboard.writeText(s);
                return true;
            }
        } catch {
            /* fallthrough */
        }
        try {
            const doc = g.document;
            if (doc) {
                const ta = doc.createElement('textarea');
                ta.value = s;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                doc.body.appendChild(ta);
                ta.select();
                const ok = doc.execCommand('copy');
                doc.body.removeChild(ta);
                return !!ok;
            }
        } catch {
            /* fallthrough */
        }
        return false;
    }

    private async readClipboard(): Promise<string | null> {
        const g = globalThis as any;
        try {
            if (g.navigator?.clipboard?.readText) {
                return (await g.navigator.clipboard.readText()) as string;
            }
        } catch {
            /* fallthrough */
        }
        return null;
    }
}

/**
 * 临时单元测试：用 Node 直接运行（node _test/rules.test.ts）
 * 验证 BoardLogic 的提子 / 禁着 / 劫 / 连五，以及连接码编解码。
 */
import { BoardLogic, Cell } from '../assets/scripts/BoardLogic.ts';
import { encodeCode, decodeCode } from '../assets/scripts/NetManager.ts';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
    if (cond) {
        passed++;
        console.log('  PASS', msg);
    } else {
        failed++;
        console.error('  FAIL', msg);
    }
}

// 1. 连五获胜
{
    const b = new BoardLogic(15);
    let r = { ok: false, captured: [], winLine: [] as any[] };
    for (let i = 0; i < 5; i++) {
        b.place(10, 3 + i, Cell.White); // 白方干扰
        r = b.place(7, 3 + i, Cell.Black);
    }
    assert(r.ok && r.winLine.length === 5, '黑棋横向连五获胜');
    // 竖连
    const b2 = new BoardLogic(15);
    for (let i = 0; i < 4; i++) {
        b2.place(i, 0, Cell.White);
        b2.place(i, 1, Cell.Black);
    }
    b2.place(5, 5, Cell.White);
    const r2 = b2.place(4, 1, Cell.Black);
    assert(r2.winLine.length === 5, '黑棋竖向连五获胜');
    // 斜连
    const b3 = new BoardLogic(15);
    for (let i = 0; i < 5; i++) {
        b3.place(0, i + 5, Cell.White);
        const rr = b3.place(3 + i, 3 + i, i === 4 ? Cell.Black : Cell.Black);
        if (i === 4) assert(rr.winLine.length === 5, '黑棋斜向连五获胜');
    }
}

// 2. 提子：角上白子被两子围杀
{
    const b = new BoardLogic(15);
    b.place(0, 0, Cell.White);
    b.place(0, 1, Cell.Black);
    const r = b.place(1, 0, Cell.Black);
    assert(r.ok && r.captured.length === 1 && r.captured[0].x === 0 && r.captured[0].y === 0, '角上白子被提');
    assert(b.get(0, 0) === Cell.Empty, '提子后交叉点为空');
}

// 3. 提子后填充空位（大块提子）
{
    const b = new BoardLogic(15);
    // 白棋一块：(1,1) 单点，被黑四面围住（含角部）
    b.place(1, 1, Cell.White);
    b.place(0, 1, Cell.Black);
    b.place(1, 0, Cell.Black);
    b.place(2, 1, Cell.Black);
    const r = b.place(1, 2, Cell.Black);
    assert(r.ok && r.captured.length === 1, '中腹白子四面被围提子');
}

// 4. 自杀禁着
{
    const b = new BoardLogic(15);
    b.place(0, 1, Cell.White);
    b.place(1, 0, Cell.White);
    const r = b.place(0, 0, Cell.Black); // 黑子落在角里，两气都是白，且不提子
    assert(!r.ok && r.reason === 'suicide', '自杀手被判为禁着点');
    assert(b.get(0, 0) === Cell.Empty, '禁着回滚后棋盘不变');
}

// 5. 劫：提劫后不可立即回提
{
    const b = new BoardLogic(15);
    // 构造经典劫形
    b.place(1, 0, Cell.Black);
    b.place(2, 0, Cell.White);
    b.place(0, 1, Cell.Black);
    b.place(3, 1, Cell.White);
    b.place(1, 2, Cell.Black);
    b.place(2, 2, Cell.White);
    b.place(1, 1, Cell.White); // 白棋仅剩 (2,1) 一口气
    const take = b.place(2, 1, Cell.Black); // 黑提劫
    assert(take.ok && take.captured.length === 1, '黑方提劫成功');
    const back = b.place(1, 1, Cell.White); // 白立即回提
    assert(!back.ok && back.reason === 'ko', '白方立即回提被判劫');
    // 白在别处走一手后可以回提
    b.place(10, 10, Cell.Black); // 黑应劫（放在别处）
    b.place(11, 10, Cell.White); // 白找劫材后……直接回提
    const retake = b.place(1, 1, Cell.White);
    assert(retake.ok, '找劫后回提合法');
}

// 6. 占位非法
{
    const b = new BoardLogic(15);
    b.place(5, 5, Cell.Black);
    const r = b.place(5, 5, Cell.White);
    assert(!r.ok && r.reason === 'occupied', '已有棋子处不可落子');
}

// 7. 连接码编解码
{
    const sdp = 'v=0\r\no=- 123456 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
    const offer = encodeCode('offer', sdp);
    const answer = encodeCode('answer', sdp);
    assert(offer.indexOf('FIGO_O_') === 0, '邀请码前缀正确');
    assert(answer.indexOf('FIGO_A_') === 0, '应答码前缀正确');
    assert(decodeCode(offer, 'offer') === sdp, '邀请码 SDP 往返一致');
    assert(decodeCode(answer, 'answer') === sdp, '应答码 SDP 往返一致');
    assert(decodeCode(offer, 'answer') === null, '类型不匹配的码被拒绝');
    assert(decodeCode('garbage', 'offer') === null, '非法码被拒绝');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);

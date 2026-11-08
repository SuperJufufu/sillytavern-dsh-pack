// 补丁：聊天保存偶发 EPERM（Windows）—— 原子写重试 + 首行读取等句柄真正关闭
// 适用版本：SillyTavern 1.19.x
// 修改文件：src/util.js
// license: AGPL-3.0
//
// 背景（两处都是通用缺陷，与角色卡 / 用户数据无关）：
//   1. tryWriteFileSync 直接用 write-file-atomic 写文件。Windows 上杀软、搜索索引器、
//      或尚未释放的读句柄会短暂锁住目标文件，rename 抛 EPERM/EBUSY → 表现为「聊天保存失败」。
//   2. readFirstLine 在拿到首行后立刻 resolve，但此时文件句柄还没真正关闭；
//      1.19 的 checkChatIntegrity() 读完首行马上就要 rename 覆盖同一个文件 → 随机 EPERM。
//      这是「保存偶发失败」的根因，所以两处一起修。
//
// 幂等：两处改动各有标记，命中即跳过。

import { replaceOnce } from './_lib.mjs';

export const meta = {
    id: 'util-save',
    title: '聊天保存 EPERM 修复（原子写重试 + 首行读取等关闭）',
    required: true,
    files: ['src/util.js'],
};

const ATOMIC_MARKER = `'EPERM', 'EACCES', 'EBUSY'`;
const ATOMIC_OLD = `    writeFileAtomicSync(filePath, data, 'utf8');\n`;
const ATOMIC_NEW = `    // DSH PATCH: Windows 上杀软 / 索引器 / 尚未关闭的读句柄会短暂锁住目标文件，
    // 导致 write-file-atomic 的 rename 抛 EPERM / EBUSY（表现：保存聊天时弹错误提示）。
    // 对可重试错误做 4 次短等待重试，最后回退到直接写入，避免丢消息。
    const retryableCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            writeFileAtomicSync(filePath, data, 'utf8');
            return;
        } catch (error) {
            const code = error?.code;
            if (!retryableCodes.has(code)) {
                throw error;
            }
            if (attempt < 3) {
                const until = Date.now() + 120 * (attempt + 1);
                while (Date.now() < until) { /* 同步短暂等待，只出现在罕见的重试路径 */ }
                continue;
            }
            console.warn(\`[DSH] atomic write failed for \${filePath} (\${code}); falling back to direct write.\`);
            fs.writeFileSync(filePath, data, 'utf8');
            return;
        }
    }
`;

const READ_MARKER = `stream.once('close', done);`;
const READ_OLD = `export function readFirstLine(filePath) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    return new Promise((resolve, reject) => {
        let resolved = false;
        rl.on('line', line => {
            resolved = true;
            rl.close();
            stream.close();
            resolve(line);
        });

        rl.on('error', error => {
            resolved = true;
            reject(error);
        });

        // Handle empty files
        stream.on('end', () => {
            if (!resolved) {
                resolved = true;
                resolve('');
            }
        });
    });
}
`;
const READ_NEW = `export function readFirstLine(filePath) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    // DSH PATCH: 必须等底层文件句柄真正 close 之后再 resolve。
    // 1.19 的 checkChatIntegrity() 读完聊天文件首行后会立即 rename 覆盖同一个文件，
    // 原实现在 resolve(line) 时句柄尚未关闭，Windows 上 rename 会报 EPERM，
    // 表现为随机出现的「聊天无法保存」错误。
    return new Promise((resolve, reject) => {
        let settled = false;
        let firstLine = '';
        const finish = () => {
            const done = () => {
                if (!settled) {
                    settled = true;
                    resolve(firstLine);
                }
            };
            if (stream.closed) {
                return done();
            }
            stream.once('close', done);
            stream.destroy();
        };
        rl.on('line', line => {
            if (settled) return;
            firstLine = line;
            rl.close();
            finish();
        });

        rl.on('error', error => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });

        // Handle empty files
        stream.on('end', () => {
            if (!settled) {
                firstLine = '';
                finish();
            }
        });
    });
}
`;

/**
 * 应用补丁（纯函数式：只返回新内容，不落盘）。
 * @param {{read: (rel: string) => string, write: (rel: string, text: string) => void}} ctx
 * @returns {{status: 'applied' | 'already-applied', notes: string[]}}
 */
export function apply(ctx) {
    const rel = meta.files[0];
    let src = ctx.read(rel);
    const notes = [];

    if (!src.includes(ATOMIC_MARKER)) {
        src = replaceOnce(src, ATOMIC_OLD, ATOMIC_NEW, 'tryWriteFileSync 里的 writeFileAtomicSync 调用');
        notes.push('原子写已加重试 / 直接写入回退');
    }

    if (!src.includes(READ_MARKER)) {
        src = replaceOnce(src, READ_OLD, READ_NEW, 'readFirstLine 函数体');
        notes.push('readFirstLine 改为等文件句柄 close 之后再返回');
    }

    if (!notes.length) {
        return { status: 'already-applied', notes: ['已存在保存 EPERM 修复，跳过'] };
    }

    ctx.write(rel, src);
    return { status: 'applied', notes };
}

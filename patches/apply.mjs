#!/usr/bin/env node
// 统一入口：把一组独立补丁按顺序打到一个 SillyTavern 1.19.x 安装目录上
// 适用版本：SillyTavern 1.19.x
// 修改文件：见 --list（默认只改必需补丁声明的文件）
// license: AGPL-3.0
//
// 用法：
//   node apply.mjs --st <SillyTavern 目录>            应用必需补丁（幂等）
//   node apply.mjs --st <SillyTavern 目录> --dry-run  只预览会改哪些文件，不写入
//   node apply.mjs --st <SillyTavern 目录> --check    只检查（0 = 全部已应用或可应用）
//   node apply.mjs --st <SillyTavern 目录> --only a,b 只应用指定补丁（可用 id 见 --list）
//   node apply.mjs --list                             列出全部补丁
//
// 安全策略：
//   · 只改补丁声明的目标文件，不碰 node_modules / 用户数据；
//   · 所有改动先在内存里算完，并用 node --check 验证语法，全部通过才落盘；
//   · 落盘前把原文件备份到 <ST>/.dsh-pack-patch-backups/<时间戳>/（保留相对路径）；
//   · 每个补丁自己带标记，重复运行只会报告「已应用，跳过」。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';
const BACKUP_DIRNAME = '.dsh-pack-patch-backups';
const REGISTRY = [
    'sd-angle.mjs',
    'sd-stable-writer.mjs',
    'util-save.mjs',
    'quick-reply.mjs',
    'deepseek-reasoning.mjs',
];

const STATUS_LABEL = {
    applied: '已应用',
    'already-applied': '已应用（跳过）',
    'would-apply': '可应用',
    failed: '失败',
};

function usage() {
    return `用法：node apply.mjs --st <SillyTavern 目录> [--dry-run] [--check] [--only id,id] [--list]`;
}

function parseArgs(argv) {
    const args = { st: '', dryRun: false, check: false, only: [], list: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--st') args.st = String(argv[++i] || '');
        else if (a.startsWith('--st=')) args.st = a.slice('--st='.length);
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--check') args.check = true;
        else if (a === '--list') args.list = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else if (a === '--only') args.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
        else if (a.startsWith('--only=')) args.only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
        else throw new Error(`未知参数：${a}`);
    }
    return args;
}

function timestamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    // 带毫秒，避免同一秒内连续运行两次时落进同一个备份目录（互相覆盖）
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 备份目录已存在时追加 -1、-2 …，绝不覆盖历史备份。 */
function uniqueDir(base) {
    if (!fs.existsSync(base)) return base;
    let i = 1;
    while (fs.existsSync(`${base}-${i}`)) i += 1;
    return `${base}-${i}`;
}

function lineCount(text) {
    return text.split('\n').length;
}

async function loadPatches() {
    const patches = [];
    for (const file of REGISTRY) {
        const mod = await import(pathToFileURL(path.join(HERE, file)).href);
        if (!mod.meta || !mod.meta.id || typeof mod.apply !== 'function') {
            throw new Error(`补丁模块结构不正确：${file}`);
        }
        patches.push({ file, meta: mod.meta, apply: mod.apply });
    }
    return patches;
}

function printList(patches) {
    console.log(`dsh 补丁包 v${VERSION}（适用 SillyTavern 1.19.x，AGPL-3.0）\n`);
    console.log('  id                   默认  修改文件');
    console.log('  ------------------   ----  ------------------------------------------------');
    for (const p of patches) {
        const def = p.meta.required ? '是  ' : '否  ';
        console.log(`  ${p.meta.id.padEnd(20)} ${def}  ${p.meta.files.join(', ')}`);
        console.log(`  ${' '.repeat(20)}       ${p.meta.title}`);
    }
    console.log('\n  默认 = 不加 --only 时应用的补丁；可选补丁用 --only <id> 单独应用。');
}

function looksLikeSt(dir) {
    return fs.existsSync(path.join(dir, 'src')) && fs.existsSync(path.join(dir, 'public', 'scripts'));
}

/** 在临时目录里用 node --check 验证将要写入的 JS，失败则抛错。 */
function checkSyntax(files) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-check-'));
    try {
        files.forEach((f, i) => {
            if (!/\.(?:cjs|mjs|js)$/i.test(f.rel)) return;
            const tmp = path.join(tmpDir, `${i}-${path.basename(f.rel)}`);
            fs.writeFileSync(tmp, f.out, 'utf8');
            try {
                execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
            } catch (error) {
                const detail = String(error?.stderr || error?.message || error);
                throw new Error(`node --check 失败：${f.rel}\n${detail}`);
            } finally {
                fs.rmSync(tmp, { force: true });
            }
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        return 0;
    }

    const patches = await loadPatches();

    if (args.list) {
        printList(patches);
        return 0;
    }

    if (!args.st) {
        console.error(usage());
        return 2;
    }

    const ST = path.resolve(args.st);
    if (!fs.existsSync(ST) || !fs.statSync(ST).isDirectory()) {
        console.error(`[apply] 目录不存在：${ST}`);
        return 2;
    }
    if (!looksLikeSt(ST)) {
        console.error(`[apply] 看起来不是 SillyTavern 目录（缺少 src/ 或 public/scripts/）：${ST}`);
        return 2;
    }

    const known = new Set(patches.map((p) => p.meta.id));
    const unknown = args.only.filter((id) => !known.has(id));
    if (unknown.length) {
        console.error(`[apply] 未知补丁 id：${unknown.join(', ')}（用 --list 查看可用 id）`);
        return 2;
    }

    const selected = args.only.length
        ? patches.filter((p) => args.only.includes(p.meta.id))
        : patches.filter((p) => p.meta.required);

    if (!selected.length) {
        console.error('[apply] 没有选中任何补丁');
        return 2;
    }

    const mode = args.check ? 'check' : args.dryRun ? 'dry-run' : 'apply';
    const prefix = mode === 'check' ? '[check]' : '[apply]';

    console.log(`${prefix} SillyTavern: ${ST}`);
    console.log(`${prefix} 补丁：${selected.map((p) => p.meta.id).join(', ')}（${mode === 'apply' ? '写入模式' : mode === 'check' ? '只检查' : '预览'}）\n`);

    // 版本提示（不阻塞）：补丁锚点是按 1.19.x 写的，别的版本大概率对不上
    try {
        const pkgPath = path.join(ST, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const version = String(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '');
            if (version && !version.startsWith('1.19')) {
                console.warn(`${prefix} 提示：目标版本是 ${version}，补丁按 SillyTavern 1.19.x 编写，锚点可能对不上。`);
            }
        }
    } catch { /* package.json 读不出来就跳过版本提示 */ }

    // ---- 内存态：所有补丁依次作用于同一份虚拟文件内容 ----
    const overlay = new Map();
    const eolOf = new Map();
    const touched = new Set();

    const read = (rel) => {
        if (overlay.has(rel)) return overlay.get(rel);
        const abs = path.join(ST, rel);
        if (!fs.existsSync(abs)) throw new Error(`目标文件不存在：${rel}`);
        const raw = fs.readFileSync(abs, 'utf8');
        eolOf.set(rel, raw.includes('\r\n') ? '\r\n' : '\n');
        const text = raw.replace(/\r\n/g, '\n');
        overlay.set(rel, text);
        return text;
    };

    const write = (rel, text) => {
        overlay.set(rel, String(text).replace(/\r\n/g, '\n'));
        touched.add(rel);
    };

    const results = [];
    for (let i = 0; i < selected.length; i++) {
        const patch = selected[i];
        const label = `[${i + 1}/${selected.length}] ${patch.meta.id.padEnd(18)}`;
        try {
            const result = await patch.apply({ read, write });
            let status = result.status;
            if (mode !== 'apply' && status === 'applied') status = 'would-apply';
            results.push({ id: patch.meta.id, status, notes: result.notes || [] });
            console.log(`${label} ${STATUS_LABEL[status] || status}`);
            for (const note of result.notes || []) console.log(`      · ${note}`);
        } catch (error) {
            results.push({ id: patch.meta.id, status: 'failed', notes: [], error: String(error?.message || error) });
            console.log(`${label} 失败`);
            console.log(`      ✗ ${error?.message || error}`);
        }
    }

    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length) {
        console.error(`\n${prefix} 有 ${failed.length} 个补丁失败，未写入任何文件。`);
        console.error(`${prefix} 建议：确认目标目录是未修改的 SillyTavern 1.19.x，或从 .dsh-pack-patch-backups 还原后重试。`);
        return 1;
    }

    // ---- 汇总要写的文件 ----
    const files = [];
    for (const rel of touched) {
        const abs = path.join(ST, rel);
        const original = fs.readFileSync(abs, 'utf8');
        const text = overlay.get(rel);
        const out = eolOf.get(rel) === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
        if (out !== original) files.push({ rel, abs, original, out });
    }

    if (!files.length) {
        console.log(`\n${prefix} 无需改动：所选补丁已全部应用。`);
        return 0;
    }

    // ---- 先验证语法，再决定是否落盘 ----
    checkSyntax(files);
    console.log(`\n${prefix} 语法检查：${files.filter((f) => /\.(?:cjs|mjs|js)$/i.test(f.rel)).length} 个文件通过 node --check`);

    if (mode !== 'apply') {
        console.log(`${prefix} 待改动文件：`);
        for (const f of files) {
            console.log(`  - ${f.rel}  (${lineCount(f.original)} → ${lineCount(f.out)} 行)`);
        }
        if (mode === 'check') {
            const applied = results.filter((r) => r.status === 'already-applied').length;
            const pending = results.filter((r) => r.status === 'would-apply').length;
            console.log(`\n${prefix} 结果：PASS（${applied} 个已应用，${pending} 个可应用，未写入任何文件）`);
        } else {
            console.log(`\n${prefix} 预览结束：未写入任何文件（去掉 --dry-run 才会真正应用）。`);
        }
        return 0;
    }

    // ---- 备份 + 写入 ----
    const stamp = timestamp();
    const backupRoot = uniqueDir(path.join(ST, BACKUP_DIRNAME, stamp));
    for (const f of files) {
        const dest = path.join(backupRoot, f.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(f.abs, dest);
    }
    fs.writeFileSync(
        path.join(backupRoot, 'manifest.json'),
        JSON.stringify({
            tool: 'dsh-sillytavern-patch-pack',
            version: VERSION,
            appliedAt: new Date().toISOString(),
            node: process.version,
            patches: results.map((r) => ({ id: r.id, status: 'applied' })),
            files: files.map((f) => f.rel),
        }, null, 2) + '\n',
        'utf8',
    );

    for (const f of files) {
        fs.writeFileSync(f.abs, f.out, 'utf8');
    }

    console.log(`${prefix} 备份：${backupRoot}`);
    console.log(`${prefix} 写入完成：${files.length} 个文件`);
    for (const f of files) console.log(`  - ${f.rel}`);
    console.log(`${prefix} 回滚：把备份目录里的文件按相同相对路径覆盖回 ${ST}`);
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(`[apply] ${error?.message || error}`);
        process.exit(1);
    });

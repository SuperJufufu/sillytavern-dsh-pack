#!/usr/bin/env node
// 补丁包自测：在临时目录里复制一份目标文件，跑完整流程（不碰原目录）
// 适用版本：SillyTavern 1.19.x
// 修改文件：无（只在系统临时目录里生成副本）
// license: AGPL-3.0
//
// 用法：
//   node selftest.mjs --stock <未打补丁的 ST 1.19.x 目录> [--live <已打补丁的 ST 目录>]
//
// 验证项：
//   1. 首次 apply 成功，且只改补丁声明的文件；
//   2. 二次 apply 幂等（全部「已应用（跳过）」，不产生新备份）；
//   3. --check 在已打补丁的副本上返回 0；
//   4. 改完的 .js 全部通过 node --check；
//   5. 可选补丁单独应用 / 重复应用也正常；
//   6. 给了 --live 时：已有补丁必须被识别为「已应用」，且 live 目录哈希不变。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCH_DIR = path.resolve(HERE, '..', 'patches');
const APPLY = path.join(PATCH_DIR, 'apply.mjs');
const REGISTRY = ['sd-angle.mjs', 'sd-stable-writer.mjs', 'util-save.mjs', 'quick-reply.mjs', 'deepseek-reasoning.mjs'];

function parseArgs(argv) {
    const args = { stock: '', live: '' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--stock') args.stock = argv[++i] || '';
        else if (a.startsWith('--stock=')) args.stock = a.slice(8);
        else if (a === '--live') args.live = argv[++i] || '';
        else if (a.startsWith('--live=')) args.live = a.slice(7);
        else throw new Error(`未知参数：${a}`);
    }
    return args;
}

async function loadMetas() {
    const metas = [];
    for (const file of REGISTRY) {
        const mod = await import(pathToFileURL(path.join(PATCH_DIR, file)).href);
        metas.push(mod.meta);
    }
    return metas;
}

function run(args, opts = {}) {
    const r = spawnSync(process.execPath, [APPLY, ...args], { encoding: 'utf8', ...opts });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function hashDir(dir) {
    const hash = crypto.createHash('sha256');
    const walk = (d) => {
        for (const name of fs.readdirSync(d).sort()) {
            const full = path.join(d, name);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) walk(full);
            else {
                hash.update(path.relative(dir, full).split(path.sep).join('/'));
                hash.update(fs.readFileSync(full));
            }
        }
    };
    walk(dir);
    return hash.digest('hex');
}

function makeSt(dir, metas, from) {
    // 只复制补丁声明要改的目标文件；顺带建出 src/ 与 public/scripts/ 让目录看起来像 ST
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'public', 'scripts'), { recursive: true });
    for (const meta of metas) {
        for (const rel of meta.files) {
            const src = path.join(from, rel);
            const dest = path.join(dir, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        }
    }
}

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.stock) {
        console.error('用法：node selftest.mjs --stock <未打补丁的 ST 1.19.x 目录> [--live <已打补丁的 ST 目录>]');
        return 2;
    }
    const metas = await loadMetas();
    const required = metas.filter((m) => m.required).map((m) => m.id);
    const optional = metas.filter((m) => !m.required).map((m) => m.id);
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-selftest-'));
    console.log(`[selftest] 临时目录：${tmpRoot}\n`);

    try {
        // ---------- 1. 必需补丁：首次 apply ----------
        const st = path.join(tmpRoot, 'st');
        makeSt(st, metas, args.stock);
        const topBefore = new Set(fs.readdirSync(st));

        const first = run(['--st', st]);
        check('必需补丁首次 apply 成功', first.code === 0, `exit=${first.code}`);
        check('首次 apply 确实写入了文件', first.out.includes('写入完成'));
        const addedTop = fs.readdirSync(st).filter((x) => !topBefore.has(x));
        check('只新增了备份目录这一个顶层项',
            addedTop.length === 1 && addedTop[0] === '.dsh-pack-patch-backups',
            `新增：${addedTop.join(', ') || '无'}`);

        // ---------- 2. 二次 apply 幂等 ----------
        const backupsAfterFirst = fs.readdirSync(path.join(st, '.dsh-pack-patch-backups'));
        const second = run(['--st', st]);
        const backupsAfterSecond = fs.readdirSync(path.join(st, '.dsh-pack-patch-backups'));
        check('二次 apply 退出码 0', second.code === 0, `exit=${second.code}`);
        check('二次 apply 全部报告已应用（跳过）',
            required.every((id) => second.out.includes(`${id.padEnd(18)} 已应用（跳过）`)),
            second.out.split('\n').filter((l) => l.includes('已应用（跳过）')).length + ' 条');
        check('二次 apply 没有产生新备份', backupsAfterFirst.length === backupsAfterSecond.length,
            `${backupsAfterFirst.length} → ${backupsAfterSecond.length}`);

        // ---------- 3. --check ----------
        const checkRun = run(['--st', st, '--check']);
        check('已打补丁副本 --check 返回 0', checkRun.code === 0, `exit=${checkRun.code}`);
        check('--check 判定为全部已应用', checkRun.out.includes('已全部应用'));

        // ---------- 4. node --check ----------
        let syntaxOk = true;
        for (const meta of metas.filter((m) => m.required)) {
            for (const rel of meta.files) {
                if (!/\.js$/i.test(rel)) continue;
                const r = spawnSync(process.execPath, ['--check', path.join(st, rel)], { encoding: 'utf8' });
                if (r.status !== 0) {
                    syntaxOk = false;
                    console.log(`      node --check 失败：${rel}\n${r.stderr}`);
                }
            }
        }
        check('改动后的 .js 全部通过 node --check', syntaxOk);

        // ---------- 5. 可选补丁 ----------
        if (optional.length) {
            const stOpt = path.join(tmpRoot, 'st-optional');
            makeSt(stOpt, metas, args.stock);
            const opt1 = run(['--st', stOpt, '--only', optional.join(',')]);
            const opt2 = run(['--st', stOpt, '--only', optional.join(',')]);
            check('可选补丁首次 apply 成功', opt1.code === 0, `exit=${opt1.code}`);
            check('可选补丁二次 apply 幂等',
                opt2.code === 0 && optional.every((id) => opt2.out.includes(`${id.padEnd(18)} 已应用（跳过）`)));
            const optCheck = run(['--st', stOpt, '--only', optional.join(','), '--check']);
            check('可选补丁 --check 返回 0', optCheck.code === 0, `exit=${optCheck.code}`);
        }

        // ---------- 6. live 已打补丁检测 ----------
        if (args.live) {
            const liveDir = path.resolve(args.live);
            const liveHashBefore = hashDir(liveDir);
            const liveSt = path.join(tmpRoot, 'st-live');
            makeSt(liveSt, metas, liveDir);
            const liveCheck = run(['--st', liveSt, '--check']);
            check('live 副本 --check 返回 0（无失败补丁）', liveCheck.code === 0, `exit=${liveCheck.code}`);
            check('live 副本上全部识别为已应用',
                required.every((id) => new RegExp(`${id}\\s+已应用（跳过）`).test(liveCheck.out)),
                liveCheck.out.split('\n').filter((l) => l.includes('已应用（跳过）')).length + ' 条');
            const liveHashAfter = hashDir(liveDir);
            check('live 目录未被修改（哈希一致）', liveHashBefore === liveHashAfter);
        }
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n[selftest] ${results.length - failed.length}/${results.length} 项通过`);
    return failed.length ? 1 : 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(`[selftest] ${error?.message || error}`);
        process.exit(1);
    });

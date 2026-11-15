#!/usr/bin/env node
/**
 * 确保安装包 payload 不含任何图片资源。
 *
 * 安装器只会分发：installer/install.ps1 + extensions/** + patches/** + LICENSE + NOTICE。
 * 这些内容里不允许出现图片文件（png/jpg/webp/gif/svg…），避免安装包/首次启动
 * 画面出现任何图片；演示图只能放在 docs/showcase（不随安装包分发）。
 *
 * 用法：node scripts/check-no-images-in-payload.mjs
 * 退出码：0 = PASS，1 = 发现图片文件
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD_DIRS = ['extensions', 'patches', 'installer'];
const IMAGE_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.ico',
    '.svg', '.tif', '.tiff', '.heic', '.heif',
]);

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === '.git' || name === 'node_modules') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

const offenders = [];
let scanned = 0;

for (const dirName of PAYLOAD_DIRS) {
    const dir = join(ROOT, dirName);
    try {
        statSync(dir);
    } catch {
        console.error(`[check] 缺少目录：${dirName}`);
        process.exit(1);
    }
    for (const file of walk(dir)) {
        scanned++;
        const ext = extname(file).toLowerCase();
        if (IMAGE_EXT.has(ext)) offenders.push(relative(ROOT, file));
    }
}

// 额外保证 LICENSE / NOTICE 仍在
for (const extra of ['LICENSE', 'NOTICE']) {
    try {
        statSync(join(ROOT, extra));
    } catch {
        console.error(`[check] 缺少文件：${extra}`);
        process.exit(1);
    }
}

if (offenders.length > 0) {
    console.error('[check] FAIL：安装包 payload 中发现图片文件（不应随安装包分发）：');
    for (const file of offenders) console.error('  - ' + file);
    console.error('[check] 演示图请只放 docs/showcase/；安装包只分发脚本/补丁/文档。');
    process.exit(1);
}

console.log(`[check] PASS：安装包 payload 共 ${scanned} 个文件，没有图片资源（png/jpg/webp/gif/svg…）。`);

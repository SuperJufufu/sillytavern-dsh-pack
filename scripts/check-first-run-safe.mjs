#!/usr/bin/env node
/**
 * 复查 SillyTavern「首次启动（开屏）」是否安全：不显示任何图片。
 *
 * 检查项（针对 ST 1.19.x 的默认内容）：
 *   1. 欢迎模板 welcomePanel.html 只引用 ST logo（没有其它静态图片）；
 *   2. default/content/settings.json 没有 background / custom_background / active_character；
 *   3. default/content/backgrounds/__transparent.png 存在（ST 首次启动的默认背景）；
 *   4. default/content/themes 与 user.css 不带 background-image / url(...) 图片。
 *
 * 用法：
 *   node scripts/check-first-run-safe.mjs --st "<SillyTavern 目录>"
 *   node scripts/check-first-run-safe.mjs --st "<SillyTavern 目录>" --verbose
 *
 * 说明：这里只验证「默认内容 + 欢迎界面」；ST 自带的默认角色表情图
 * 是官方 SFW 素材，不会出现在开屏上，不在本脚本的判定范围内。
 *
 * 退出码：0 = PASS，1 = 有风险项
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const stIndex = args.indexOf('--st');
const verbose = args.includes('--verbose') || args.includes('-v');

if (args.includes('--help') || args.includes('-h') || stIndex < 0 || !args[stIndex + 1]) {
    console.log('用法：node scripts/check-first-run-safe.mjs --st "<SillyTavern 目录>" [--verbose]');
    process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}

const st = args[stIndex + 1];
const problems = [];
const notes = [];

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

// 1. 欢迎模板
const welcomePanel = join(st, 'public/scripts/templates/welcomePanel.html');
if (!existsSync(welcomePanel)) {
    problems.push('缺少欢迎模板：public/scripts/templates/welcomePanel.html');
} else {
    const html = readFileSync(welcomePanel, 'utf8');
    const srcs = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map(m => m[1]);
    const allowed = new Set(['img/logo.png', '{{char_thumbnail}}']);
    const unexpected = srcs.filter(src => !allowed.has(src));
    if (unexpected.length > 0) {
        problems.push(`欢迎模板出现非 logo 图片引用：${unexpected.join(', ')}`);
    }
    notes.push(`欢迎模板图片引用：${srcs.join(', ') || '无'}`);
    if (/\{\{char_thumbnail\}\}/.test(html) && !/\{\{#if empty\}\}/.test(html)) {
        problems.push('欢迎模板使用 {{char_thumbnail}} 但没有 empty 分支，全新安装可能渲染空缩略图');
    }
}

// 2. 默认 settings
const settingsPath = join(st, 'default/content/settings.json');
if (!existsSync(settingsPath)) {
    problems.push('缺少 default/content/settings.json');
} else {
    const settings = readJson(settingsPath);
    if (settings.background) problems.push(`默认 settings 设置了 background：${JSON.stringify(settings.background)}`);
    if (settings.custom_background) problems.push(`默认 settings 设置了 custom_background：${JSON.stringify(settings.custom_background)}`);
    if (settings.active_character) problems.push(`默认 settings 有 active_character：${JSON.stringify(settings.active_character)}`);
    notes.push(`默认背景：background=${settings.background ?? 'null'}, custom_background=${settings.custom_background ?? 'null'}`);
}

// 3. 默认背景资源
const transparent = join(st, 'default/content/backgrounds/__transparent.png');
if (!existsSync(transparent)) problems.push('缺少 default/content/backgrounds/__transparent.png');
else notes.push('默认背景资源存在：backgrounds/__transparent.png');

// 4. 默认主题 / user.css 不应带图片背景
for (const rel of ['default/content/themes', 'default/content/user.css']) {
    const target = join(st, rel);
    if (!existsSync(target)) continue;
    const files = [];
    const walk = (p) => {
        if (statSync(p).isFile()) files.push(p);
        else for (const n of readdirSync(p)) walk(join(p, n));
    };
    statSync(target).isDirectory() ? walk(target) : files.push(target);
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        if (/background-image\s*:/i.test(text) || /url\(\s*['"]?(?!data:)/i.test(text)) {
            problems.push(`默认主题/user.css 含图片背景引用：${file}`);
        }
    }
    notes.push(`已检查无图片背景：${rel}`);
}

// 5. 版本信息（可选）
const pkgPath = join(st, 'package.json');
let version = '';
if (existsSync(pkgPath)) {
    try { version = readJson(pkgPath).version || ''; } catch { /* ignore */ }
}

if (verbose) for (const note of notes) console.log('[info] ' + note);
if (problems.length > 0) {
    console.error('[check] FAIL：首次启动画面存在风险项：');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
}
console.log(`[check] PASS：ST ${version || '(未知版本)'} 首次启动为深色界面 + ST logo，无背景图片、无激活角色。`);
console.log('[check] 佐证截图：docs/showcase/first-run-splash.png / docs/showcase/first-run.png');

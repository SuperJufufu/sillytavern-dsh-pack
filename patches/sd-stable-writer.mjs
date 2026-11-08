// 补丁：把写词稳定器（dsh-prompt-stable）接进 SD 扩展的写词链路
// 适用版本：SillyTavern 1.19.x
// 修改文件：public/scripts/extensions/stable-diffusion/index.js
// license: AGPL-3.0
//
// 作用：
//   1. 写词优先交给 window.__DSH_PROMPT_STABLE.writePrompt（缓存 / 聊天变量 / 一致性合并 / 规则兜底）；
//      该扩展未安装时自动回落到原版 generateQuietPrompt，行为与 stock 一致；
//   2. 写词返回空时，用 window.__DSH_PROMPT_STABLE.fallbackTags 的规则提示词兜底，不再直接放弃出图；
//   3. 顺带把 generationType 传给写词器，并按需附带外貌档案（装了 sd-appearance 扩展时才有值）。
//
// 与 sd-angle 的关系：两个补丁改的是同一文件的不同位置，互不重叠，先后顺序随意；
// 角度要求在 generatePrompt 开头写进 quietPrompt，本补丁只是把「写词」这一步换了个实现。
//
// 幂等：所有改动带标记，命中标记即跳过。

import { replaceOnce } from './_lib.mjs';

export const meta = {
    id: 'sd-stable-writer',
    title: 'SD 写词稳定器钩子（__DSH_PROMPT_STABLE）',
    required: true,
    files: ['public/scripts/extensions/stable-diffusion/index.js'],
};

const STABLE_MARKER = '// DSH STABLE:';
const FALLBACK_MARKER = "window.__DSH_PROMPT_STABLE?.fallbackTags?.({ appearanceBlock";

// 1) 函数签名多带一个 generationType
const SIG_OLD = `async function generatePrompt(quietPrompt) {`;
const SIG_NEW = `async function generatePrompt(quietPrompt, generationType) {`;

// 2) 唯一调用点同步传参
const CALL_OLD = `            prompt = await generatePrompt(quietPrompt);`;
const CALL_NEW = `            prompt = await generatePrompt(quietPrompt, generationType);`;

// 3) 写词入口：先问稳定器，拿不到再走原版
const REPLY_OLD = `    const reply = await generateQuietPrompt({ quietPrompt });\n`;
const REPLY_NEW = `    let appearanceBlock = '';
    try {
        // 可选：装了外貌档案扩展（sd-appearance）时，把角色外貌一起交给写词器
        if (typeof window.__DSH_APPEARANCE_BLOCK_ASYNC === 'function') {
            appearanceBlock = String((await window.__DSH_APPEARANCE_BLOCK_ASYNC()) || '');
        }
    } catch (e) {
        console.warn('[stable-diffusion] appearance block failed', e);
    }
    let reply = '';
    // DSH STABLE: 写词优先交给 dsh-prompt-stable（缓存 / 聊天变量对象 / 一致性合并 / 规则兜底）
    try {
        if (window.__DSH_PROMPT_STABLE && typeof window.__DSH_PROMPT_STABLE.writePrompt === 'function') {
            reply = String(await window.__DSH_PROMPT_STABLE.writePrompt({
                quietPrompt,
                generationType,
                appearanceBlock,
                angleHint: window.__DSH_SD_ANGLE_HINT || '',
            }) || '');
            if (String(reply).trim()) {
                console.log('[stable-diffusion] 写词来自 dsh-prompt-stable，长度 ' + reply.length);
            }
        }
    } catch (e) {
        console.warn('[stable-diffusion] stable writer failed, fallback legacy', e);
    }
    if (!String(reply).trim()) {
        reply = await generateQuietPrompt({ quietPrompt });
    }
`;

// 4) 空回复兜底
const EMPTY_OLD = `    if (!processedReply) {\n        toastr.error(`;
const EMPTY_NEW = `    if (!processedReply) {
        const fb = window.__DSH_PROMPT_STABLE?.fallbackTags?.({ appearanceBlock, angleHint: window.__DSH_SD_ANGLE_HINT || '', reason: 'empty-reply' });
        if (fb && String(fb).trim()) {
            console.warn('[stable-diffusion] 写词为空，改用规则兜底提示词');
            window.__DSH_SD_LAST = { prompt: String(fb), n: 1, regions: [], globalText: String(fb), negativeExtra: '' };
            return String(fb);
        }
        toastr.error(`;

/**
 * 应用补丁（纯函数式：只返回新内容，不落盘）。
 * @param {{read: (rel: string) => string, write: (rel: string, text: string) => void}} ctx
 * @returns {{status: 'applied' | 'already-applied', notes: string[]}}
 */
export function apply(ctx) {
    const rel = meta.files[0];
    let src = ctx.read(rel);
    const notes = [];

    if (!src.includes(STABLE_MARKER)) {
        src = replaceOnce(src, SIG_OLD, SIG_NEW, 'generatePrompt 函数签名');
        src = replaceOnce(src, CALL_OLD, CALL_NEW, 'generatePicture 里调用 generatePrompt 的一行');
        src = replaceOnce(src, REPLY_OLD, REPLY_NEW, 'generatePrompt 里调用 generateQuietPrompt 的一行');
        notes.push('已接入写词稳定器（__DSH_PROMPT_STABLE.writePrompt），未安装时回落原版');
    }

    if (!src.includes(FALLBACK_MARKER)) {
        src = replaceOnce(src, EMPTY_OLD, EMPTY_NEW, '空回复判定 if (!processedReply)');
        notes.push('已为空回复增加规则提示词兜底');
    }

    if (!notes.length) {
        return { status: 'already-applied', notes: ['已存在写词稳定器钩子，跳过'] };
    }

    ctx.write(rel, src);
    return { status: 'applied', notes };
}

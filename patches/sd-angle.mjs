// 补丁：Stable Diffusion 扩展「角度配图」
// 适用版本：SillyTavern 1.19.x
// 修改文件：public/scripts/extensions/stable-diffusion/index.js
// license: AGPL-3.0
//
// 作用：在一次正常出图之外，让外部脚本按指定镜头类型再补一张同场景的图。
// 对外接口（挂在 window 上）：
//   __DSH_SD_ANGLE_HINTS    { scene, closeup } 镜头提示词表
//   __DSH_SD_ANGLE_HINT     本轮要附加的镜头要求（由 __DSH_SD_ANGLE_GENERATE 设置，空串 = 不附加）
//   __DSH_SD_ANGLE_GENERATE (kind) => Promise  按镜头类型生成一张图（scene / closeup）
//   __DSH_SD_ANGLE_READY    true = 补丁已就绪
//
// 实现要点（对照 1.19.x 源码）：
//   1. generatePrompt() 是「用 LLM 写生图提示词」的唯一入口，镜头要求追加到它的 quietPrompt；
//   2. 全局函数挂在模块顶层，内部调用 generatePicture(initiators.command, {}, 'last')，
//      与用户手动触发出图走完全同一条链路（前缀 / 负向词 / 触发词全部沿用）。
//
// 幂等：两处改动各有标记；命中标记即跳过，重复运行不会重复插入。

import { replaceOnce } from './_lib.mjs';

export const meta = {
    id: 'sd-angle',
    title: 'SD 角度配图（__DSH_SD_ANGLE_*）',
    required: true,
    files: ['public/scripts/extensions/stable-diffusion/index.js'],
};

// 改动 1：generatePrompt 里把本轮镜头要求追加到写词指令
const HINT_MARKER = '// DSH ANGLE: 本轮镜头要求';
// 另一种已知接线方式（把镜头要求作为提示词数组的一个元素）。命中它就说明
// 目标文件已经用别的实现接好了镜头要求，此时保留现状、不重复插入。
const HINT_WIRED_ELSEWHERE = '...(window.__DSH_SD_ANGLE_HINT';
const HINT_ANCHOR = `    const toast = toastr.info('Generating image prompt with an LLM...', 'Image Generation');\n`;
const HINT_BLOCK = `${HINT_ANCHOR}    // DSH ANGLE: 本轮镜头要求（由 __DSH_SD_ANGLE_GENERATE 设置）追加到写词指令\n    if (window.__DSH_SD_ANGLE_HINT) {\n        quietPrompt = String(quietPrompt) + '\\n\\n' + String(window.__DSH_SD_ANGLE_HINT);\n    }\n`;

// 改动 2：模块顶层注入全局函数（放在 init() 之前，此时 initiators / generatePicture 均已就绪）
const READY_MARKER = 'window.__DSH_SD_ANGLE_READY = true;';
const INIT_ANCHOR = `export async function init() {`;

const HINTS = `const DSH_ANGLE_HINTS = {
    scene: 'CAMERA LOCK: the FIRST tags of the prompt MUST be "wide shot, full body, wide angle, wide field of view". All characters must be fully inside the frame with normal anatomy and proportions: NO close-up, NO POV, NO cropped or out-of-frame limbs, NO disembodied legs, NO giant body parts. Show the whole location clearly.',
    closeup: 'CAMERA LOCK: the FIRST tags of the prompt MUST be "close-up, portrait, upper body". ONE character occupies the frame (face and upper body, clear expression). NO split screen, NO collage, NO multi-panel, NO wide shot, NO full body, shallow depth of field.',
};`;

const GLOBALS = `// ===== DSH ANGLE (SillyTavern 1.19.x / AGPL-3.0) =====
// 提供「按镜头角度再出一张图」的能力（供外部自动化调用）：
//   __DSH_SD_ANGLE_HINT     当前一轮要附加的镜头要求（空字符串 = 不附加）
//   __DSH_SD_ANGLE_HINTS    可用镜头类型与提示词
//   __DSH_SD_ANGLE_GENERATE 按类型生成一张图（scene / closeup）
//   __DSH_SD_ANGLE_READY    补丁已就绪标记
${HINTS}
window.__DSH_SD_ANGLE_HINTS = DSH_ANGLE_HINTS;
window.__DSH_SD_ANGLE_GENERATE = async (kind = 'scene') => {
    const prev = window.__DSH_SD_ANGLE_HINT;
    window.__DSH_SD_ANGLE_HINT = DSH_ANGLE_HINTS[kind] || DSH_ANGLE_HINTS.scene;
    try {
        console.log('[stable-diffusion] 角度出图: ' + kind);
        return await generatePicture(initiators.command, {}, 'last');
    } finally {
        window.__DSH_SD_ANGLE_HINT = prev || '';
    }
};
window.__DSH_SD_ANGLE_READY = true;
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
    const skipped = [];
    let changed = false;

    if (!src.includes(READY_MARKER)) {
        src = replaceOnce(src, INIT_ANCHOR, `${GLOBALS}\n${INIT_ANCHOR}`, 'SD 初始化入口 export async function init()');
        notes.push('已注入 __DSH_SD_ANGLE_* 全局函数与镜头提示词表');
        changed = true;
    } else {
        skipped.push('__DSH_SD_ANGLE_* 全局函数已存在');
    }

    const hintWired = src.includes(HINT_MARKER) || src.includes(HINT_WIRED_ELSEWHERE);
    if (!hintWired) {
        src = replaceOnce(src, HINT_ANCHOR, HINT_BLOCK, 'generatePrompt 的 toastr 起始行');
        notes.push('已把本轮镜头要求接入 generatePrompt 的写词指令');
        changed = true;
    } else {
        skipped.push(src.includes(HINT_MARKER) ? '镜头要求接线已存在' : '镜头要求已由另一种实现接线，保留现状');
    }

    if (!changed) {
        return { status: 'already-applied', notes: skipped };
    }

    ctx.write(rel, src);
    return { status: 'applied', notes };
}

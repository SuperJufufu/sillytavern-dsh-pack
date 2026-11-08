// 补丁（可选）：快捷回复不再被「系统消息」触发
// 适用版本：SillyTavern 1.19.x
// 修改文件：public/scripts/extensions/quick-reply/index.js
// license: AGPL-3.0
//
// 背景：onAiMessage 只看消息内容，不看消息类型。出图产生的图片消息、斜杠命令回显、
// 注释等都属于 is_system 的系统消息，并不是「AI 回复」，但在 1.19.x 里同样会触发
// executeOnAi —— 于是「每轮出图」的设置会在图片消息上再触发一次 /imagine，形成递归出图。
//
// 这是通用的行为修正（与角色卡 / 用户数据无关），但会改变「系统消息也触发快捷回复」
// 这一既有行为，所以列为可选补丁，默认不应用。
//
// 幂等：带标记，命中即跳过。

import { replaceOnce } from './_lib.mjs';

export const meta = {
    id: 'quick-reply',
    title: '快捷回复：系统消息不触发 executeOnAi',
    required: false,
    files: ['public/scripts/extensions/quick-reply/index.js'],
};

const MARKER = `QR auto-execution suppressed for system message`;
const OLD = `    if (['...'].includes(chat[messageId]?.mes)) {
        log('QR auto-execution suppressed for swiped message');
        return;
    }
`;
const NEW = `${OLD}
    // DSH PATCH: 系统消息（出图产生的图片消息、斜杠命令回显、注释等）不是「AI 回复」，
    // 不应触发 executeOnAi 的快捷回复，否则「每轮出图」会在图片消息上再次触发出图命令。
    if (chat[messageId]?.is_system) {
        log('QR auto-execution suppressed for system message');
        return;
    }
`;

/**
 * 应用补丁（纯函数式：只返回新内容，不落盘）。
 * @param {{read: (rel: string) => string, write: (rel: string, text: string) => void}} ctx
 * @returns {{status: 'applied' | 'already-applied', notes: string[]}}
 */
export function apply(ctx) {
    const rel = meta.files[0];
    const src = ctx.read(rel);

    if (src.includes(MARKER)) {
        return { status: 'already-applied', notes: ['系统消息闸门已存在，跳过'] };
    }

    const out = replaceOnce(src, OLD, NEW, 'onAiMessage 里 swiped 消息闸门');
    ctx.write(rel, out);
    return { status: 'applied', notes: ['已为 executeOnAi 增加 is_system 闸门'] };
}

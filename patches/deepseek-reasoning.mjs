// 补丁（可选）：DeepSeek 后端的 Reasoning Effort 取值映射
// 适用版本：SillyTavern 1.19.x
// 修改文件：src/endpoints/backends/chat-completions.js
// license: AGPL-3.0
//
// 背景：SillyTavern 的「Reasoning Effort」滑块取值是 min/low/medium/high/max，
// 而 DeepSeek 的 chat/completions 只认 none/low/medium/high —— 直接把 max 发过去会被
// 服务端拒绝，把 min 发过去也无法真正关闭思考。这里做一层厂商专用映射：
//   min → none（完全关闭思考，出字最快）
//   max → high
//   auto（空值）→ 不发送，交给服务端默认
//
// 只对 DeepSeek 分支生效，不影响其它 OpenAI 兼容后端。不过它属于「特定厂商的行为调整」，
// 不是所有人都会想要的默认行为，所以列为可选补丁。
//
// 幂等：带标记，命中即跳过。

import { replaceOnce } from './_lib.mjs';

export const meta = {
    id: 'deepseek-reasoning',
    title: 'DeepSeek：Reasoning Effort 取值映射',
    required: false,
    files: ['src/endpoints/backends/chat-completions.js'],
};

const MARKER = 'deepseekReasoningEffortMap';
const OLD = `        if (request.body.include_reasoning && request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort;
        }`;
const NEW = `        // DSH PATCH: 把 ST 的「Reasoning Effort」映射成 DeepSeek 接受的取值。
        // UI 选 "Minimum" → 发送 reasoning_effort: none = 完全关闭思考（出字最快、流式最明显）。
        // "auto" 不发送，保持与升级前 1.13.2 行为一致（交给服务端默认）。
        const deepseekReasoningEffortMap = { min: 'none', low: 'low', medium: 'medium', high: 'high', max: 'high' };
        const deepseekReasoningEffort = deepseekReasoningEffortMap[String(request.body.reasoning_effort || '').toLowerCase()];
        if (request.body.include_reasoning && request.body.reasoning_effort && deepseekReasoningEffort) {
            bodyParams['reasoning_effort'] = deepseekReasoningEffort;
        }`;

/**
 * 应用补丁（纯函数式：只返回新内容，不落盘）。
 * @param {{read: (rel: string) => string, write: (rel: string, text: string) => void}} ctx
 * @returns {{status: 'applied' | 'already-applied', notes: string[]}}
 */
export function apply(ctx) {
    const rel = meta.files[0];
    const src = ctx.read(rel);

    if (src.includes(MARKER)) {
        return { status: 'already-applied', notes: ['Reasoning Effort 映射已存在，跳过'] };
    }

    const out = replaceOnce(src, OLD, NEW, 'DeepSeek 分支的 reasoning_effort 赋值');
    ctx.write(rel, out);
    return { status: 'applied', notes: ['已加入 DeepSeek 的 reasoning_effort 映射（min→none, max→high）'] };
}

/**
 * 示例：把 dsh-swipe-shots 的出图后端换成「云端生图 API」。
 *
 * 这是可选的示例脚本，不随安装包分发；只覆盖页面里的
 *   window.__DSH_SD_ANGLE_GENERATE(kind)
 * 不会修改 SillyTavern 的任何文件。
 *
 * 使用方式（三选一）：
 *   1) 作为 ST 扩展/QuickReply 的脚本加载；
 *   2) 浏览器 F12 控制台粘贴运行（刷新后失效）；
 *   3) 自己包成一个 ST 扩展（manifest + index.js）常驻。
 *
 * ⚠️ 先把下面的配置换成你自己的服务；不要把 API key 提交到任何仓库。
 * ⚠️ 不同云厂商的请求/响应格式不同，请按文档改 callCloudImage()。
 */
(function () {
    'use strict';

    // ---------------------------------------------------------------- 配置
    const CONFIG = {
        // OpenAI 兼容的图片接口；其它厂商改这里的路径和请求体
        endpoint: 'https://api.example.com/v1/images/generations',
        apiKey: '',              // ⚠️ 不要写进公开仓库；运行时填/从本地设置读
        model: 'sdxl-or-cloud-image-model',
        size: '1024x1024',
        // 可选：自定义提示词模板（{scene} 会被替换成最近一条 AI 消息文本）
        promptTemplate: '{scene}',
        // 可选：请求超时（毫秒）
        timeoutMs: 120000,
    };

    const KIND_HINTS = {
        scene: 'wide shot, full body, environment visible, cinematic composition',
        closeup: 'close-up portrait, upper body, detailed face, soft lighting',
    };

    function ctx() {
        try { return window.SillyTavern?.getContext?.() ?? null; } catch (e) { return null; }
    }

    function latestAiText() {
        const c = ctx();
        const chat = c?.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system && m.mes) return String(m.mes).slice(0, 600);
        }
        return '';
    }

    async function callCloudImage(prompt) {
        const body = {
            model: CONFIG.model,
            prompt,
            n: 1,
            size: CONFIG.size,
            response_format: 'b64_json',
        };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
        try {
            const res = await fetch(CONFIG.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(CONFIG.apiKey ? { Authorization: 'Bearer ' + CONFIG.apiKey } : {}),
                },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            if (!res.ok) throw new Error('image API HTTP ' + res.status);
            const data = await res.json();
            const b64 = data?.data?.[0]?.b64_json || data?.images?.[0]?.b64;
            if (!b64) throw new Error('image API 返回里找不到 b64 图片');
            return 'data:image/png;base64,' + b64;
        } finally {
            clearTimeout(timer);
        }
    }

    async function insertImageMessage(dataUrl, kind, prompt) {
        const c = ctx();
        if (!c) throw new Error('拿不到 SillyTavern context');
        const name = c.name2 || c.characters?.[c.characterId]?.name || 'SillyTavern';
        const msg = {
            name,
            is_user: false,
            is_system: false,
            send_date: Date.now(),
            mes: '',
            extra: {
                image: dataUrl,
                title: prompt,
                generationType: kind,
                inline_image: false,
                image_swipes: [dataUrl],
            },
        };
        c.chat.push(msg);
        c.addOneMessage(msg);
        // 聊天保存（与 ST 前端一致；util.js 的 EPERM 修复会让保存更稳）
        try {
            await fetch('/api/chats/save', {
                method: 'POST',
                headers: c.getRequestHeaders(),
                body: JSON.stringify({
                    file_name: c.chatId,
                    avatar_url: c.characters?.[c.characterId]?.avatar,
                    chat: c.chat,
                    force: false,
                }),
            });
        } catch (e) {
            console.warn('[cloud-image-adapter] 保存聊天失败', e);
        }
    }

    // 覆盖角度图入口：dsh-swipe-shots 会优先调用它
    window.__DSH_SD_ANGLE_GENERATE = async function (kind) {
        const scene = latestAiText();
        const prompt = (CONFIG.promptTemplate || '{scene}')
            .replace('{scene}', scene)
            .replace('{kind}', kind || '') + (KIND_HINTS[kind] ? ', ' + KIND_HINTS[kind] : '');
        if (!scene) throw new Error('没有可用的聊天内容来生成提示词');
        const dataUrl = await callCloudImage(prompt);
        await insertImageMessage(dataUrl, kind, prompt);
    };

    // 若没有 patches/sd-angle，扩展会读这个（可选）
    window.__DSH_SD_ANGLE_HINTS = window.__DSH_SD_ANGLE_HINTS || {
        scene: KIND_HINTS.scene,
        closeup: KIND_HINTS.closeup,
    };

    console.log('[cloud-image-adapter] 已覆盖 __DSH_SD_ANGLE_GENERATE（示例）');
})();

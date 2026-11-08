/**
 * DSH 角度配图 (dsh-swipe-shots) v1.1.0  —— 2026-11-07
 *
 * 只做两件事（v1.1.0 起移除「2 条候选 + 滑动选择器」）：
 *  1) 角度配图：每条 AI 回复结束后，按这条内容生成 2 张不同角度的图：
 *       scene   = 同场景另一视角（广角/侧面/俯视，交代环境与在场人物）
 *       closeup = 另一位在场角色 / 另一角度的近景特写
 *     直接复用 stable-diffusion 扩展的写词+出图链路（window.__DSH_SD_ANGLE_GENERATE），
 *     图片消息由 SD 扩展自己写入聊天，本扩展负责去重/替换/标记。
 *  2) 隐藏提示词：把「系统图片消息」里的 [xxx sends a picture that contains: …] 文字
 *     在显示层隐藏，只留图片。
 *
 * 手动在 ST 里滑到另一条回复时，会按新选中的回复重出这一组角度图（用户主动操作，不是自动 2 候选）。
 * 没有依赖、不改 ST 核心；删掉本文件夹即可完全移除。
 */
(function () {
    'use strict';

    const NAME = 'dsh-swipe-shots';
    const VERSION = '1.1.0';
    const LOG_PREFIX = '[dsh-swipe-shots]';

    const DEFAULTS = {
        enabled: true,          // 总开关
        afterGenDelay: 800,     // 回复结束后直接出图的延迟(ms)
        shots: 'scene,closeup', // 两条镜头类型
        debug: false,
    };

    // ---------- 基础工具 ----------
    function ctx() {
        try { return window.SillyTavern?.getContext?.() ?? null; } catch (e) { return null; }
    }
    function log(...a) { try { if (S().debug) console.log(LOG_PREFIX, ...a); } catch (e) { /* ignore */ } }
    function warn(...a) { try { console.warn(LOG_PREFIX, ...a); } catch (e) { /* ignore */ } }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function waitFor(fn, timeout = 180000, step = 300) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            try { const v = fn(); if (v) return v; } catch (e) { /* ignore */ }
            await sleep(step);
        }
        return null;
    }
    function S() {
        const c = ctx();
        if (!c) return { ...DEFAULTS };
        const es = c.extensionSettings;
        if (!es[NAME]) es[NAME] = {};
        const s = es[NAME];
        for (const k of Object.keys(DEFAULTS)) if (s[k] === undefined) s[k] = DEFAULTS[k];
        return s;
    }
    function saveSettings() { try { ctx()?.saveSettingsDebounced?.(); } catch (e) { /* ignore */ } }

    // ---------- 状态 ----------
    let busy = false;             // 正在生成 2 张角度图
    let pendingPick = null;       // 生成中又被手动滑了一次，记下最新的消息 id
    const swipeTimers = new Map(); // mesId -> timeout

    // ---------- 判断 ----------
    function isAIMessage(m) {
        return !!m && m.is_user !== true && m.is_system !== true && String(m.mes || '').trim().length > 0;
    }
    function lastAIMessageId() {
        const c = ctx();
        if (!c) return -1;
        const chat = c.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) if (isAIMessage(chat[i])) return i;
        return -1;
    }
    function currentSwipeId(m) {
        const arr = Array.isArray(m?.swipes) ? m.swipes : null;
        if (!arr) return 0;
        return Math.max(0, Math.min(Number(m.swipe_id ?? 0) || 0, arr.length - 1));
    }
    function ensureShotMeta(c) {
        if (!c.chatMetadata) c.chatMetadata = {};
        if (!c.chatMetadata.__dsh_swipe_shots || typeof c.chatMetadata.__dsh_swipe_shots !== 'object') {
            c.chatMetadata.__dsh_swipe_shots = {};
        }
        return c.chatMetadata.__dsh_swipe_shots;
    }

    // ---------- 给消息打/找标记 ----------
    function tagNewMessages(beforeLen, forId, swipeId, kind) {
        const c = ctx();
        if (!c) return 0;
        const chat = c.chat || [];
        let n = 0;
        for (let i = beforeLen; i < chat.length; i++) {
            const m = chat[i];
            if (!m) continue;
            m.extra = m.extra || {};
            m.extra.__dsh_shot = { for: Number(forId), swipe: Number(swipeId), kind: String(kind), ts: Date.now() };
            n++;
        }
        return n;
    }
    function findShotMessages(forId) {
        const c = ctx();
        if (!c) return [];
        const chat = c.chat || [];
        const out = [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const s = chat[i]?.extra?.__dsh_shot;
            if (s && Number(s.for) === Number(forId)) out.push(i);
        }
        return out;
    }

    // ---------- 删除旧角度图（换了一个候选时先撤掉上一组） ----------
    async function removeOldShots(forId) {
        const c = ctx();
        if (!c) return;
        const idxs = findShotMessages(forId);
        for (const i of idxs) {
            try {
                log('remove old shot message', i);
                await c.deleteMessage(i);
            } catch (e) { warn('delete old shot failed', e); }
        }
    }

    // ---------- 生成 2 张角度图 ----------
    async function runShots(mesId, reason = '') {
        if (!S().enabled) return;
        if (busy) { pendingPick = mesId; log('shots busy, queue', mesId); return; }
        const c = ctx();
        if (!c) return;
        const chat = c.chat || [];
        const m = chat[mesId];
        if (!m || !isAIMessage(m)) { log('skip shots: not AI message', mesId); return; }
        if (lastAIMessageId() !== mesId) { log('skip shots: not latest AI message', mesId); return; }
        if (typeof window.__DSH_SD_ANGLE_GENERATE !== 'function') {
            warn('SD 角度出图函数不存在（stable-diffusion 扩展未加载或未打补丁）');
            return;
        }

        const swipeId = currentSwipeId(m);
        const key = `${mesId}:${swipeId}`;
        const meta = ensureShotMeta(c);
        const kinds = String(S().shots || DEFAULTS.shots).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 2);
        if (!kinds.length) return;

        // 同一候选已经生成过就跳过；换了候选则先撤旧的
        const existing = findShotMessages(mesId);
        if (meta[key]) {
            log('shots already generated for', key);
            return;
        }
        if (existing.length) await removeOldShots(mesId);
        // 清掉该消息其它候选的旧记录
        for (const k of Object.keys(meta)) if (k.startsWith(`${mesId}:`)) delete meta[k];

        busy = true;
        const chatIdAtStart = c.chatId;
        try {
            log('generate shots', key, kinds, reason);
            for (const kind of kinds) {
                const cc = ctx();
                if (!cc || cc.chatId !== chatIdAtStart) { warn('chat changed, abort shots'); return; }
                const before = (cc.chat || []).length;
                await window.__DSH_SD_ANGLE_GENERATE(kind);
                const tagged = tagNewMessages(before, mesId, swipeId, kind);
                log('shot generated', kind, 'tagged', tagged);
                try { cc.saveChat?.(); } catch (e) { /* ignore */ }
                await sleep(400);
            }
            meta[key] = Date.now();
            try { ctx()?.saveMetadataDebounced?.(); } catch (e) { /* ignore */ }
        } catch (e) {
            warn('shot generation failed', e);
        } finally {
            busy = false;
            if (pendingPick !== null && pendingPick !== mesId) {
                const next = pendingPick;
                pendingPick = null;
                setTimeout(() => runShots(next, 'pending'), 200);
            } else {
                pendingPick = null;
            }
        }
    }

    // ---------- 生成结束后的主流程（v1.1.0：不再生成第 2 条候选、不弹选择器） ----------
    async function afterMessageReady(mesId) {
        if (!S().enabled) return;
        const c = ctx();
        if (!c) return;
        const m = c.chat?.[mesId];
        if (!m || !isAIMessage(m)) return;
        await waitFor(() => document.body.dataset.generating !== 'true', 120000, 300);
        await sleep(Number(S().afterGenDelay) || DEFAULTS.afterGenDelay);
        await runShots(mesId, 'after generation');
    }

    async function onGenerationEnded() {
        if (!S().enabled) return;
        if (busy) return;
        const c = ctx();
        if (!c || !Array.isArray(c.chat)) return;
        const mesId = lastAIMessageId();
        if (mesId < 0) return;
        await afterMessageReady(mesId);
    }

    // ---------- 用户手动滑动查看另一条回复时，按选中的回复重出角度图 ----------
    function onMessageSwiped(mesId) {
        if (!S().enabled) return;
        const id = Number(mesId);
        if (!Number.isInteger(id) || id < 0) return;
        const c = ctx();
        if (!c || lastAIMessageId() !== id) return;
        if (swipeTimers.has(id)) clearTimeout(swipeTimers.get(id));
        const t = setTimeout(() => {
            swipeTimers.delete(id);
            if (busy) return;
            runShots(id, 'swipe changed');
        }, 1300);
        swipeTimers.set(id, t);
    }

    // ---------- 隐藏系统图片消息里的提示词文字 ----------
    // 注意：1.19 的 MessageFormatter 钩子只对非 system 消息生效（script.js 里包在 if(!isSystem) 里），
    // 而 SD 出图的图片消息是 system 消息，所以这里用 CSS + DOM 标记来做显示层隐藏：
    // 给「system 且有图片附件」的消息加 .dsh-hide-prompt 类，只隐藏 .mes_text，图片照常显示。
    function hasMediaExtra(m) {
        return (Array.isArray(m?.extra?.media) && m.extra.media.length > 0) || !!m?.extra?.image;
    }
    function runPromptHider() {
        try {
            const c = ctx();
            if (!c) return;
            const chat = c.chat || [];
            document.querySelectorAll('#chat .mes[mesid]').forEach((el) => {
                const id = Number(el.getAttribute('mesid'));
                const m = chat[id];
                const hide = !!(m && m.is_system === true && hasMediaExtra(m));
                el.classList.toggle('dsh-hide-prompt', hide);
            });
        } catch (e) { /* ignore */ }
    }
    function installPromptHider() {
        if (window.__DSH_HIDE_PROMPT_INSTALLED) return;
        window.__DSH_HIDE_PROMPT_INSTALLED = true;
        try {
            const style = document.createElement('style');
            style.id = 'dsh-swipe-shots-style';
            style.textContent = '#chat .mes.dsh-hide-prompt > .mes_block > .mes_text { display: none !important; }';
            document.head.appendChild(style);
        } catch (e) { /* ignore */ }
        window.__DSH_HIDE_PROMPT_RUN = runPromptHider;

        const c = ctx();
        if (c) {
            const events = ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED'];
            for (const ev of events) {
                try { c.eventSource.on(c.eventTypes[ev], () => setTimeout(runPromptHider, 120)); } catch (e) { /* ignore */ }
            }
        }
        let t = null;
        const debounced = () => { if (t) clearTimeout(t); t = setTimeout(runPromptHider, 100); };
        try {
            const chatEl = document.getElementById('chat');
            if (chatEl) new MutationObserver(debounced).observe(chatEl, { childList: true, subtree: true });
        } catch (e) { /* ignore */ }
        setTimeout(runPromptHider, 800);
        setTimeout(runPromptHider, 3000);
        log('prompt hider installed');
    }

    // ---------- 设置面板 ----------
    function buildPanel() {
        if (document.getElementById(`${NAME}-panel`)) return;
        const host = document.getElementById('extensions_settings2');
        if (!host) return;
        const s = S();
        const div = document.createElement('div');
        div.id = `${NAME}-panel`;
        div.className = 'dsh-swipe-shots-panel';
        div.innerHTML = `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>DSH 角度配图 v${VERSION}</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" id="dshss-enabled"> 启用（角度配图 + 隐藏提示词）</label>
    <label class="checkbox_label"><input type="checkbox" id="dshss-debug"> 调试日志（F12 控制台）</label>
    <label>镜头类型（逗号分隔，最多 2 个；scene=场景另一视角，closeup=人物近景）</label>
    <input type="text" id="dshss-shots" class="text_pole" />
    <label>回复结束后出图延迟（毫秒）</label>
    <input type="number" id="dshss-afterGenDelay" class="text_pole" min="0" step="100" />
    <div class="dshss-status" id="dshss-status"></div>
  </div>
</div>`;
        host.appendChild(div);
        const bind = (id, key, type) => {
            const el = div.querySelector('#' + id);
            if (!el) return;
            if (type === 'bool') el.checked = !!s[key]; else el.value = s[key];
            const ev = type === 'bool' ? 'change' : 'input';
            el.addEventListener(ev, () => {
                s[key] = type === 'bool' ? !!el.checked : (type === 'num' ? Number(el.value) : el.value);
                saveSettings();
                log('setting', key, '=', s[key]);
            });
        };
        bind('dshss-enabled', 'enabled', 'bool');
        bind('dshss-debug', 'debug', 'bool');
        bind('dshss-shots', 'shots', 'str');
        bind('dshss-afterGenDelay', 'afterGenDelay', 'num');
    }

    // ---------- 初始化 ----------
    async function init() {
        const c = await waitFor(() => ctx(), 300000, 300);
        if (!c) return;
        await waitFor(() => document.getElementById('extensions_settings2'), 120000, 500);
        buildPanel();
        installPromptHider();
        try {
            c.eventSource.on(c.eventTypes.GENERATION_ENDED, () => { onGenerationEnded().catch((e) => warn('gen ended handler error', e)); });
            c.eventSource.on(c.eventTypes.MESSAGE_SWIPED, (mesId) => onMessageSwiped(mesId));
            c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { pendingPick = null; });
        } catch (e) {
            warn('event hook failed', e);
        }
        window.__DSH_SWIPE_SHOTS = {
            version: VERSION,
            settings: S,
            state: () => ({ busy, pendingPick, lastAI: lastAIMessageId() }),
            generateShots: (id) => runShots(Number.isInteger(id) ? id : lastAIMessageId(), 'manual'),
            clear: (key) => { try { const meta = ensureShotMeta(ctx()); if (key) delete meta[key]; else ctx().chatMetadata.__dsh_swipe_shots = {}; ctx().saveMetadataDebounced?.(); } catch (e) { /* ignore */ } },
        };
        console.log(`${LOG_PREFIX} v${VERSION} 已加载`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { init(); }, { once: true });
    } else {
        init();
    }
})();

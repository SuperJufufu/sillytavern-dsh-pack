/**
 * 对话自动命名 (chat-namer) v2.1.0
 *
 * 用 DeepSeek（ST 主模型，generateRaw）给每个对话自动起一个 6–14 字的中文标题，
 * 并自动重命名聊天文件（角色聊天 / 群聊都支持）。本地 1.5B（8030）作为兜底。
 *
 * 触发：
 *   · AI 回复渲染后（对话早期的第 1~6 条 AI 消息内命名一次）
 *   · 打开一个还没有被自动命名过的旧对话时补命名（可选，默认开）
 *   · 之后每 N 轮对话（默认 5 条 AI 回复）自动更新一次标题，反映最新剧情
 * 只改「默认时间戳名」的对话（`角色名 - 2026-10-25@00h33m11s` 这种）；
 * 你手动改过名的一律不动，并且会永久停止自动更新这一段（chat_metadata.__dsh_manual）。
 *
 * 删掉 extensions/chat-namer 即可移除。
 */
(function () {
    'use strict';

    const MODULE = 'chat-namer';
    const MARK = '__dsh_autonamed';      // 曾被自动命名过
    const TITLE = '__dsh_title';         // 上次自动设置/更新的标题
    const TITLE_AT = '__dsh_titleAt';    // 上次命名时的 AI 消息数（用于每 N 轮更新）
    const MANUAL = '__dsh_manual';       // 用户手动改过名 → 停止自动更新
    const VERSION = '2.1.0';

    const DEFAULTS = {
        enabled: true,
        engine: 'main',            // main = DeepSeek（generateRaw）| local = 8030 本地 1.5B | auto = 主模型优先，失败用本地
        url: 'http://127.0.0.1:8030',
        model: 'qwen2.5-1.5b',
        maxChars: 18,
        minAiMessages: 1,
        maxAiMessages: 6,
        nameOnChatOpen: true,      // 打开旧对话也补命名（只补默认时间戳名的）
        updateEveryN: 5,           // 每 N 条 AI 回复自动更新一次标题；0 = 不更新
        lastTitle: '',
        lastError: '',
        lastAt: 0,
    };

    const SYSTEM = [
        '你是对话标题生成器，只输出标题本身，不要解释、不要引号、不要前缀。',
        '根据对话内容，用简体中文起一个 6-14 个字的标题，概括地点、事件或氛围，像小说章节名。',
        '禁止出现身体部位、露骨性描写、脏话或呻吟声；不要照抄对话原句。',
        '标题里不要出现引号、括号、书名号、句号、逗号等标点，不要换行。',
        '示例：酒馆里的初遇 / 雨夜追踪 / 草药与篝火 / 森林中的低语 / 王都的黄昏',
    ].join('\n');

    const BAD_WORDS = /(乳|奶|胸|臀|射|插|穴|屌|肏|淫|呻吟|巨根|肉棒|巨乳|J杯|阴|睾丸|精液|高潮)/;
    const BAD_WORDS_G = new RegExp(BAD_WORDS.source, 'g');

    // 默认聊天名：`角色名 - 2026-10-25@00h33m11s` / 群聊同名格式
    const DEFAULT_NAME_RE = /[-–—]\s*\d{4}-\d{1,2}-\d{1,2}@\d{2}h\d{2}m\d{2}s(?:\.\d+ms)?$/;
    const LEGACY_DEFAULT_RE = /^(新的对话|New Chat|Untitled)$/i;

    let busy = false;
    let pendingImages = 0;

    const ctx = () => window.SillyTavern.getContext();

    // ---------- 出图/生成进行中就别改名（改名会重载聊天，正在生成的图会被丢弃） ----------
    (function hookFetch() {
        const orig = window.fetch;
        if (!orig || orig.__cnHooked) return;
        const wrapped = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const isImg = /\/api\/sd\//.test(url) || /\/api\/sd\/comfy/.test(url);
            if (isImg) pendingImages++;
            const p = orig.apply(this, arguments);
            if (isImg && p && typeof p.finally === 'function') {
                p.finally(() => { pendingImages = Math.max(0, pendingImages - 1); });
            }
            return p;
        };
        wrapped.__cnHooked = true;
        window.fetch = wrapped;
    })();

    function isGenerating() {
        // 注意：不能只看 #mes_stop 有没有 displayNone 类 —— 这个版本里它是用样式表
        // 隐起来的（classList 里没有 displayNone），会一直误判成"正在生成"。
        try { if (document.body.dataset.generating === 'true') return true; } catch (e) { /* ignore */ }
        const stop = document.getElementById('mes_stop');
        if (stop) {
            try {
                const cs = getComputedStyle(stop);
                if (cs.display !== 'none' && cs.visibility !== 'hidden' && stop.offsetParent !== null) return true;
            } catch (e) { /* ignore */ }
        }
        try { return window.__DSH_GEN_GUARD?.sdBusy?.() === true; } catch (e) { return false; }
    }

    async function waitIdle(maxMs = 120000) {
        const t0 = Date.now();
        let calm = 0;
        while (Date.now() - t0 < maxMs) {
            await new Promise((r) => setTimeout(r, 1500));
            if (!isGenerating() && pendingImages === 0) {
                calm += 1.5;
                if (calm >= 3) return true;
            } else {
                calm = 0;
            }
        }
        return false;
    }

    function settings() {
        const c = ctx();
        if (!c.extensionSettings[MODULE] || typeof c.extensionSettings[MODULE] !== 'object') {
            c.extensionSettings[MODULE] = {};
        }
        // 必须复用同一个对象，否则后续 settings() 会把外部拿到的引用替换掉，赋值丢失
        const s = c.extensionSettings[MODULE];
        for (const k of Object.keys(DEFAULTS)) {
            if (s[k] === undefined) s[k] = DEFAULTS[k];
        }
        return s;
    }

    function save() {
        try { ctx().saveSettingsDebounced?.(); } catch (e) { /* ignore */ }
    }

    function status(text) {
        const el = document.getElementById('cn-status');
        if (el) el.textContent = text;
        console.log('[chat-namer] ' + text);
    }

    function currentTitle() {
        const c = ctx();
        return String(c.chatId || '');
    }

    function looksDefaultName(title) {
        const t = String(title || '').trim();
        if (!t) return false;
        return DEFAULT_NAME_RE.test(t) || LEGACY_DEFAULT_RE.test(t);
    }

    function aiMessages() {
        const chat = ctx().chat || [];
        return chat.filter((m) => !m.is_user && !m.is_system
            && String(m.mes || '').trim()
            && !/sends a picture/i.test(String(m.mes)));
    }

    function maskedLines(n) {
        const c = ctx();
        const chat = c.chat || [];
        return chat
            .filter((m) => !m.is_system && String(m.mes || '').trim())
            .filter((m) => !/sends a picture/i.test(String(m.mes)))
            .slice(-n)
            .map((m) => `${m.is_user ? (c.name1 || '用户') : (m.name || '角色')}：${String(m.mes || '').slice(0, 300)}`)
            .join('\n')
            .replace(BAD_WORDS_G, '……');
    }

    /** 只保留中文/字母/数字，去掉标点与文件名非法字符 */
    function sanitize(raw) {
        const s = settings();
        let t = String(raw || '');
        t = t.split('\n')[0].trim();
        t = t.replace(/^(标题[:：]\s*)/, '');
        t = t.replace(/[「」『』"'“”‘’《》〈〉【】\[\]()（）]/g, '');
        t = t.replace(/[\\/:*?"<>|]/g, '');
        t = t.replace(/[，。！？、；：,.!?;:～~…—\-]+$/g, '');
        t = t.replace(/\s+/g, ' ').trim();
        const max = Math.max(6, Number(s.maxChars) || 18);
        if (t.length > max) t = t.slice(0, max);
        return t;
    }

    // ---------------------------------------------------------------- 标题生成 --
    /** DeepSeek（主模型）起名：走 generateRaw，和聊天用的是同一个 API */
    async function askTitleMain(strict, mode) {
        const c = ctx();
        if (typeof c.generateRaw !== 'function') throw new Error('当前环境没有 generateRaw');
        const update = mode === 'update';
        const lines = maskedLines(update ? 10 : 6);
        if (!lines) throw new Error('没有可用的对话内容');
        const extra = strict
            ? '\n注意：上一个标题含露骨内容。这次只根据场景、地点、事件命名，忽略一切身体与性描写。'
            : '';
        const focus = update ? '这是同一段对话的最新进展（不是开头），标题要反映现在发生的事。\n' : '';
        const prompt = '对话内容：\n' + lines + '\n\n' + focus + '只输出标题本身（6-14 个简体汉字，不要标点，不要解释）。' + extra;
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const raw = await Promise.race([
                    c.generateRaw({
                        prompt,
                        systemPrompt: SYSTEM,
                        responseLength: 200,
                        quietToLoud: true,
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('DeepSeek 起名超时 45s')), 45000)),
                ]);
                const title = sanitize(raw);
                if (title && title.length >= 2) return title;
                throw new Error('主模型返回空标题');
            } catch (e) {
                lastErr = e;
                console.warn('[chat-namer] DeepSeek 第 ' + attempt + ' 次失败：', e);
                if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
            }
        }
        throw lastErr || new Error('DeepSeek 起名失败');
    }

    /** 本地 1.5B（8030）起名：主模型不可用时的兜底 */
    async function askTitleLocal(strict, mode) {
        const s = settings();
        const update = mode === 'update';
        const lines = maskedLines(update ? 10 : 6);
        if (!lines) throw new Error('没有可用的对话内容');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const extra = strict
            ? '\n【注意】上一个标题含露骨内容。这次只根据场景、地点、事件命名，忽略一切身体与性描写。'
            : '\n只依据场景、地点、事件命名，忽略身体与性描写。';
        const focus = update ? '（这是同一段对话的最新进展，标题要反映现在发生的事）\n' : '';
        try {
            const r = await fetch(String(s.url).replace(/\/$/, '') + '/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: ctrl.signal,
                body: JSON.stringify({
                    model: s.model,
                    messages: [
                        { role: 'system', content: SYSTEM },
                        { role: 'user', content: '对话内容：\n' + lines + '\n\n' + focus + '标题：' + extra },
                    ],
                    max_tokens: 60,
                    temperature: strict ? 0.5 : 0.8,
                    stream: false,
                }),
            });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            return sanitize(String(j.choices?.[0]?.message?.content || ''));
        } finally {
            clearTimeout(timer);
        }
    }

    async function askTitle(strict, mode) {
        const s = settings();
        const engine = String(s.engine || 'main').toLowerCase();
        const order = engine === 'local' ? ['local']
            : engine === 'auto' ? ['main', 'local']
                : ['main', 'local'];
        let lastErr = null;
        for (const eng of order) {
            try {
                const title = eng === 'main' ? await askTitleMain(strict, mode) : await askTitleLocal(strict, mode);
                if (title && title.length >= 2) return title;
                throw new Error(eng + ' 返回空标题');
            } catch (e) {
                lastErr = e;
                console.warn('[chat-namer] ' + eng + ' 起名失败：', e);
            }
        }
        throw lastErr || new Error('没有可用的起名引擎');
    }

    /** 兜底标题：角色名 + 场景词（避免用"新的对话"这种废名字） */
    function fallbackTitle() {
        const c = ctx();
        const chat = c.chat || [];
        const text = chat.map((m) => String(m.mes || '')).join('\n');
        const locs = ['草原', '森林', '酒馆', '卧房', '卧室', '城堡', '王都', '小巷', '海边', '洞穴', '雪原', '沙漠', '教室', '办公室', '庭院', '湖边', '山道', '集市', '篝火', '地下', '公馆', '地下室'];
        const loc = locs.find((x) => text.includes(x)) || '初遇';
        let who = String(c.name2 || '').trim();
        if (!who) {
            const raw = c.groups || [];
            const list = Array.isArray(raw) ? raw : Object.values(raw);
            const g = list.find((x) => String(x.id) === String(c.groupId));
            who = g ? String(g.name || '').split('·')[0].trim() : '';
        }
        return `${who || '群聊'} · ${loc}`;
    }

    // ---------------------------------------------------------------- 主流程 ----
    async function nameChat(force, reason) {
        if (busy) return;
        const s = settings();
        if (!s.enabled && !force) return;
        const c = ctx();
        if (document.querySelector('.welcomePanel')) return;
        if (!c.chatId && !c.groupId && !String(c.name2 || '').trim()) return;
        const md = c.chatMetadata || {};
        if (md[MARK] && !force) return;

        const title0 = currentTitle();
        if (!title0) { status('当前没有打开的聊天'); return; }
        if (!force && !looksDefaultName(title0)) {
            // 已经是自定义名字了（手动改过的），不要覆盖；顺便打标记避免以后重复检查
            md[MARK] = true;
            try { c.saveMetadata?.(); } catch (e) { /* ignore */ }
            return;
        }

        const ai = aiMessages();
        const isOpenTrigger = ['chat open', 'page load', 'debug-open'].includes(String(reason || ''));
        if (!force) {
            if (ai.length < (Number(s.minAiMessages) || 1)) return;
            // 新回复触发时只在对话早期命名（避免把聊了很久的对话突然改名）；
            // 但"打开一段还没名字的旧对话"时不受上限限制 —— 每个对话都应该有名字。
            if (!isOpenTrigger && ai.length > (Number(s.maxAiMessages) || 6)) return;
        }
        if (!ai.length) { status('还没有 AI 回复可用'); return; }

        busy = true;
        try {
            status('① 正在用 ' + (String(s.engine) === 'local' ? '本地模型' : 'DeepSeek') + '想标题…');
            let title = '';
            try {
                title = await askTitle(false);
                if (BAD_WORDS.test(title)) {
                    status('① 标题太露骨，换个干净的…');
                    title = await askTitle(true);
                }
            } catch (e) {
                s.lastError = String(e.message || e);
                save();
                console.warn('[chat-namer] 起名失败，用兜底标题', e);
            }
            if (!title || BAD_WORDS.test(title)) title = fallbackTitle();
            if (!title || title.length < 2) throw new Error('没有生成有效标题');

            // 等文字生成 / 出图都结束再改名，否则正在生成的图会被 ST 丢弃
            if (isGenerating() || pendingImages > 0) {
                status('⏳ 等生成/出图结束再改名…');
                const ok = await waitIdle();
                if (!ok) throw new Error('一直在生成，本次先不改名（避免丢图）');
            }

            status('② 重命名为「' + title + '」…');
            const oldId = currentTitle();
            try {
                await c.renameChat(oldId, title);
            } catch (e) {
                const alt = (title + '-' + String(Date.now()).slice(-4)).slice(0, Math.max(6, Number(s.maxChars) || 18));
                status('② 重名了，改用「' + alt + '」…');
                await c.renameChat(oldId, alt);
                title = alt;
            }
            const md2 = ctx().chatMetadata || {};
            md2[MARK] = true;
            md2[TITLE] = title;
            md2[TITLE_AT] = ai.length;
            md2[MANUAL] = false;
            s.lastTitle = title;
            s.lastError = '';
            s.lastAt = Date.now();
            save();
            try { await ctx().saveMetadata?.(); } catch (e) { /* ignore */ }
            status('✅ 已命名为「' + title + '」');
            console.log('[chat-namer] 已命名「' + title + '」(' + (reason || 'auto') + ')');
        } catch (e) {
            s.lastError = String(e.message || e);
            save();
            console.error('[chat-namer]', e);
            status('❌ ' + (e.message || e));
        } finally {
            busy = false;
        }
    }

    // ------------------------------------------------- 每 N 轮自动更新标题 ----
    /**
     * 每 updateEveryN 条 AI 回复更新一次标题（默认 5 条）：
     *   · 手动改过名的对话 → 检测到标题与上次自动标题不同，永久停更（__dsh_manual）
     *   · 生成的新标题与当前标题一样 → 不改名（避免白重载聊天）
     *   · 改名前照例等生成/出图结束
     */
    async function updateTitle(reason) {
        if (busy) return;
        const s = settings();
        if (!s.enabled) return;
        const everyN = Math.max(0, Number(s.updateEveryN) || 0);
        if (!everyN) return;
        const c = ctx();
        if (document.querySelector('.welcomePanel')) return;
        const title = currentTitle();
        if (!title) return;
        const md = c.chatMetadata || {};
        if (md[MANUAL]) return;

        const autoTitle = String(md[TITLE] || '');
        if (autoTitle && title !== autoTitle) {
            // 标题被用户改过 → 以后不再自动更新这一段
            md[MANUAL] = true;
            try { c.saveMetadata?.(); } catch (e) { /* ignore */ }
            status('检测到你手动改过标题，这段对话不再自动更新');
            return;
        }
        if (!md[MARK] && !autoTitle && !looksDefaultName(title)) {
            // 既没有自动命名记录、名字也不是默认时间戳 → 视为手动命名，别动
            md[MANUAL] = true;
            try { c.saveMetadata?.(); } catch (e) { /* ignore */ }
            return;
        }

        const ai = aiMessages();
        if (!ai.length) return;
        let at = Number(md[TITLE_AT] || 0);
        if (!at) {
            // 第一次接触这段聊天（比如批量命名过的旧对话）：从当前消息数开始计
            md[TITLE_AT] = ai.length;
            if (!md[TITLE] && title) md[TITLE] = title;
            md[MARK] = true;
            try { c.saveMetadata?.(); } catch (e) { /* ignore */ }
            return;
        }
        if (ai.length - at < everyN) return;

        busy = true;
        try {
            status('🔄 已过 ' + everyN + ' 轮，正在更新标题…');
            let newTitle = '';
            try {
                newTitle = await askTitle(false, 'update');
                if (BAD_WORDS.test(newTitle)) newTitle = await askTitle(true, 'update');
            } catch (e) {
                s.lastError = String(e.message || e);
                save();
                console.warn('[chat-namer] 更新标题失败：', e);
            }
            if (!newTitle || BAD_WORDS.test(newTitle)) { status('⚠️ 更新标题失败，先不改'); return; }
            if (newTitle === title) {
                md[TITLE_AT] = ai.length;
                md[TITLE] = title;
                try { await c.saveMetadata?.(); } catch (e) { /* ignore */ }
                status('标题无需变化（仍为「' + title + '」）');
                return;
            }
            if (isGenerating() || pendingImages > 0) {
                status('⏳ 等生成/出图结束再改标题…');
                const ok = await waitIdle();
                if (!ok) { status('一直在生成，本次先不改标题'); return; }
            }
            const oldId = currentTitle();
            let finalName = newTitle;
            try {
                await c.renameChat(oldId, newTitle);
            } catch (e) {
                finalName = (newTitle + '-' + String(Date.now()).slice(-4)).slice(0, Math.max(6, Number(s.maxChars) || 18));
                await c.renameChat(oldId, finalName);
            }
            const md2 = ctx().chatMetadata || {};
            md2[MARK] = true;
            md2[TITLE] = finalName;
            md2[TITLE_AT] = ai.length;
            md2[MANUAL] = false;
            s.lastTitle = finalName;
            s.lastError = '';
            s.lastAt = Date.now();
            save();
            try { await ctx().saveMetadata?.(); } catch (e) { /* ignore */ }
            status('✅ 标题已更新为「' + finalName + '」');
            console.log('[chat-namer] 标题更新「' + title + '」→「' + finalName + '」(' + (reason || '') + ')');
        } catch (e) {
            s.lastError = String(e.message || e);
            save();
            console.error('[chat-namer] 更新标题出错', e);
            status('❌ 更新标题出错：' + (e.message || e));
        } finally {
            busy = false;
        }
    }

    // ---------------------------------------------------------------- 面板 ----
    function buildPanel() {
        if (document.getElementById('cn-panel')) return;
        const host = document.getElementById('extensions_settings');
        if (!host) return;
        const s = settings();
        const div = document.createElement('div');
        div.id = 'cn-panel';
        div.className = 'extension_container';
        div.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>对话自动命名（DeepSeek）</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="cn-enabled" ${s.enabled ? 'checked' : ''}>
                        <span>自动给对话起中文标题（只改默认时间戳名，手动改过的不动）</span>
                    </label>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>起名模型</span>
                        <select id="cn-engine" class="text_pole" style="width:auto;">
                            <option value="main" ${s.engine === 'main' ? 'selected' : ''}>DeepSeek（主模型 API）</option>
                            <option value="auto" ${s.engine === 'auto' ? 'selected' : ''}>自动（DeepSeek 失败用本地 1.5B）</option>
                            <option value="local" ${s.engine === 'local' ? 'selected' : ''}>本地 1.5B（8030）</option>
                        </select>
                    </div>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>标题最多</span>
                        <input type="number" id="cn-max" class="text_pole" min="6" max="40" style="width:64px;" value="${s.maxChars}">
                        <span>字</span>
                        <span style="margin-left:12px;">只在第</span>
                        <input type="number" id="cn-min" class="text_pole" min="1" max="20" style="width:56px;" value="${s.minAiMessages}">
                        <span>~</span>
                        <input type="number" id="cn-maxai" class="text_pole" min="1" max="30" style="width:56px;" value="${s.maxAiMessages}">
                        <span>条 AI 回复内自动命名</span>
                    </div>
                    <label class="checkbox_label">
                        <input type="checkbox" id="cn-onopen" ${s.nameOnChatOpen ? 'checked' : ''}>
                        <span>打开旧对话时也补命名（没有标记、仍是默认时间戳名的）</span>
                    </label>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>之后每</span>
                        <input type="number" id="cn-update" class="text_pole" min="0" max="100" style="width:64px;" value="${s.updateEveryN}">
                        <span>条 AI 回复自动更新一次标题（0 = 不更新）</span>
                    </div>
                    <div class="flex-container flexGap5" style="flex-wrap:wrap;">
                        <div id="cn-now" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">立即重命名当前对话</div>
                        <div id="cn-update-now" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">立即更新标题</div>
                        <span id="cn-status" style="font-size:12px;opacity:.75;flex:1 1 120px;min-width:0;line-height:1.4;"></span>
                    </div>
                    <div id="cn-last" style="font-size:11px;opacity:.6;margin-top:6px;line-height:1.4;word-break:break-word;">
                        上次标题：${s.lastTitle || '(无)'}${s.lastError ? '｜上次错误：' + String(s.lastError).slice(0, 80) : ''}
                    </div>
                    <small style="opacity:.6;display:block;margin-top:6px;">
                        起名走 ST 主模型 API（DeepSeek），每段对话约 500~800 token；每 N 轮更新一次标题，反映最新剧情。你手动改过名的对话不会再被自动更新。
                    </small>
                </div>
            </div>`;
        host.appendChild(div);

        div.querySelector('#cn-enabled').addEventListener('change', (e) => {
            settings().enabled = e.target.checked; save();
            status(e.target.checked ? '已开启自动命名' : '已暂停自动命名');
        });
        div.querySelector('#cn-engine').addEventListener('change', (e) => {
            settings().engine = e.target.value; save();
            status('起名模型：' + e.target.value);
        });
        div.querySelector('#cn-max').addEventListener('change', (e) => {
            settings().maxChars = Math.max(6, Number(e.target.value) || 18); save();
            status('标题最多 ' + settings().maxChars + ' 字');
        });
        div.querySelector('#cn-min').addEventListener('change', (e) => {
            settings().minAiMessages = Math.max(1, Number(e.target.value) || 1); save();
        });
        div.querySelector('#cn-maxai').addEventListener('change', (e) => {
            settings().maxAiMessages = Math.max(1, Number(e.target.value) || 6); save();
        });
        div.querySelector('#cn-onopen').addEventListener('change', (e) => {
            settings().nameOnChatOpen = e.target.checked; save();
            status(e.target.checked ? '打开旧对话会补命名' : '打开旧对话不补命名');
        });
        div.querySelector('#cn-update').addEventListener('change', (e) => {
            settings().updateEveryN = Math.max(0, Number(e.target.value) || 0); save();
            status(settings().updateEveryN ? '每 ' + settings().updateEveryN + ' 条 AI 回复更新一次标题' : '已关闭标题自动更新');
        });
        div.querySelector('#cn-now').addEventListener('click', () => nameChat(true, 'manual'));
        div.querySelector('#cn-update-now').addEventListener('click', () => updateTitle('manual'));
        status('就绪');
    }

    // ---------------------------------------------------------------- 启动 ----
    jQuery(async () => {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            const c = ctx();
            c.eventSource.on(c.eventTypes.CHARACTER_MESSAGE_RENDERED, () => {
                setTimeout(() => nameChat(false, 'new reply'), 1500);
                // 每 N 轮更新一次标题（nameChat 里会先处理"还没名字"的情况）
                setTimeout(() => updateTitle('new reply'), 3500);
            });
            c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
                if (!settings().nameOnChatOpen) return;
                setTimeout(() => nameChat(false, 'chat open'), 2500);
                setTimeout(() => updateTitle('chat open'), 5000);
            });
            buildPanel();
            // 页面加载时聊天可能已经打开：补一次
            if (settings().nameOnChatOpen) {
                setTimeout(() => nameChat(false, 'page load'), 4000);
                setTimeout(() => updateTitle('page load'), 6500);
            }
            const s = settings();
            console.log('[chat-namer] v' + VERSION + ' 已加载，engine=' + s.engine + ' 本地兜底=' + s.url);
        } catch (e) {
            console.error('[chat-namer] 初始化失败', e);
        }
    });

    // 调试工具
    window.__DSH_CHATNAMER = {
        version: VERSION,
        state: () => {
            const s = settings();
            const md = ctx().chatMetadata || {};
            return {
                enabled: s.enabled, engine: s.engine, maxChars: s.maxChars,
                minAiMessages: s.minAiMessages, maxAiMessages: s.maxAiMessages,
                nameOnChatOpen: s.nameOnChatOpen, updateEveryN: s.updateEveryN,
                lastTitle: s.lastTitle, lastError: s.lastError,
                busy, title: currentTitle(), aiCount: aiMessages().length,
                looksDefault: looksDefaultName(currentTitle()),
                marked: !!md[MARK], titleCache: md[TITLE] || '', titleAt: Number(md[TITLE_AT] || 0),
                manual: !!md[MANUAL],
            };
        },
        name: (force) => nameChat(force !== false, 'debug'),
        open: () => nameChat(false, 'debug-open'),
        update: () => updateTitle('debug'),
        title: () => currentTitle(),
    };
})();

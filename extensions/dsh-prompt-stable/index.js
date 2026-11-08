/**
 * DSH 写词稳定器 (dsh-prompt-stable) v1.1.0  —— 2026-11-07
 *
 * 目标：把「AI 自动写生图提示词」这条链路翻新并加强稳定性。
 *
 * v1.1.0 自动维护外观核心标签（本次新增）：
 *  - 核心表从「每个聊天手动点一次」升级为「全局表 + 自动维护」：存进扩展设置，
 *    所有聊天共用一份；写词、一致性合并、规则兜底都优先读它。
 *  - 自动触发：切换聊天 / 角色卡或人格改动（CHARACTER_EDITED、PERSONA_CHANGED、CHARACTER_RENAMED）
 *    / 世界书保存（WORLDINFO_UPDATED）/ 每 N 条 AI 回复 / 最长有效期到期 / 写词前兜底检查。
 *  - 全部是本地读取与规则解析，不额外调用大模型，不增加主线生成成本。
 *  - 合并优先级：角色卡/人格 > 世界书/角色书 > sd-appearance 外观标签；同维度
 *    （breasts/hair/eyes/ears…）冲突保留高优先级；角色别名映射可配置（默认空）；
 *    单角色标签上限 40（可调）；只用「当前对话 scope」的外观档案条目，避免跨聊天串味。
 *  - 安全：失败保留旧核心表、绝不阻塞出图；面板可随时「立即重建 / 清空核心表 / 复制 JSON」。
 *
 * 用到的 1.19 新能力（对应优化指南 7/8/9/10）：
 *  7. 条件宏 / 嵌套宏：写词指令模板支持 {{if x}}…{{else}}…{{/if}}（可嵌套）与 {{token}}，
 *     默认模板按 单人/多人、是否角度镜头、是否背景 自动组装指令；模板可在面板里改。
 *  8. 变量对象：每个聊天把「场景 / 人物稳定标签 / 最近好提示词 / 写词缓存」存进聊天状态，
 *     并镜像到 ST 聊天变量（dsh_ps_*），世界书/人格里可以直接用 {{getvar::dsh_ps_scene}} 读。
 *  9. /getcharbook /getpersonabook：面板按钮「重建外观核心标签」会读当前角色卡、人格，
 *     以及通过这两个命令拿到的角色书/人格书条目，抽出【SD标签】等外观标签作为"人物稳定标签"。
 * 10. 推理块命令：自动折叠思考块（details.mes_reasoning_details），写词调用本身用
 *     reasoning_effort=min 不产生可见思考。
 *
 * 稳定性：
 *  - 写词缓存：同一聊天、同一批对话文本 + 同一外观 + 同一镜头 → 直接复用上次提示词（不重复调 LLM）。
 *  - 一致性合并：把外观档案里的稳定标签补进每个角色段，避免同一角色跨图发色/瞳色/耳朵漂移。
 *  - 规则兜底：LLM 写词失败/写成剧情/为空时，用外观档案 + 场景状态 + 镜头规则直接拼提示词，
 *    保证仍然能出图（不再直接放弃）。
 *  - 只读集成：SD 扩展通过 window.__DSH_PROMPT_STABLE.writePrompt / fallbackTags 调用。
 */
(function () {
    'use strict';

    const NAME = 'dsh-prompt-stable';
    const VERSION = '1.1.0';
    const LOG = '[dsh-prompt-stable]';

    const DEFAULT_TEMPLATE = [
        'Write ONE line of comma-separated English danbooru/SDXL tags describing the visible scene of the LAST chat message.',
        'Order: (1) character count tags exactly once; (2) camera framing; (3) location, time, weather, light; (4) spatial arrangement; (5) the main interaction; (6) one segment per visible character.',
        '{{if multi}}For multiple characters: one line with " | " separators. The FIRST segment is GLOBAL ONLY (count, framing, scene, arrangement, interaction) and must NOT contain any character appearance. Then one segment per character, left to right; EVERY character segment MUST start with the character exact Chinese name followed by "：" (full-width colon).{{else}}Single character: one line of tags, no " | " separators, no name prefix.{{/if}}',
        '{{if angle_scene}}CAMERA LOCK: first tags MUST be "wide shot, full body, wide angle". All characters fully in frame with normal anatomy; NO close-up, NO cropped limbs.{{/if}}',
        '{{if angle_closeup}}CAMERA LOCK: first tags MUST be "close-up, portrait, upper body". ONE character, face and upper body, NO split screen, NO collage.{{/if}}',
        'No lip tags (use only closed mouth / open mouth / smile / smirk / grin). No narration, no dialogue, no explanations, no quotes, no XML, no table edits. Output tags only.',
    ].join('\n');

    const DEFAULTS = {
        enabled: true,
        useTemplate: true,
        template: DEFAULT_TEMPLATE,
        cache: true,
        cacheMs: 15 * 60 * 1000,
        consistency: true,
        fallback: true,
        autoCollapseReasoning: true,
        debug: false,
        // ---- 公开版可配置项（v0.3 泛化）----
        aliases: {},                  // 角色别名映射，例如 { '旁白': 'narrator' }
        appearanceBooks: [],          // 外观世界书名（如 ['外观书A','外观书B']；空 = 只用角色卡/人格绑定的书）
        // ---- v1.1.0 自动维护外观核心标签 ----
        coreStore: null,              // 全局核心表（持久化到扩展设置）
        autoMaintain: true,           // 自动维护总开关
        autoOnChatChange: true,       // 切换聊天时刷新
        autoOnSourceChange: true,     // 角色卡/人格/世界书/外观变化时刷新
        autoEveryN: 6,                // 每 N 条 AI 回复刷新一次（0 = 关）
        autoBookRefresh: true,        // 世界书内容参与核心表（关闭后只用卡/人格/外观）
        autoCheckMs: 60 * 1000,       // 后台检查源指纹的间隔
        coreMaxAgeMs: 30 * 60 * 1000, // 核心表最长有效期，到期自动重建
        bookRefreshMs: 10 * 60 * 1000,// 世界书内容最短刷新间隔（避免频繁读盘）
        maxTagsPerChar: 40,           // 单角色标签上限
        pruneDays: 30,                // 多少天没再从任何来源出现就清掉
    };

    // ---------------------------------------------------------------- 基础
    function ctx() { try { return window.SillyTavern?.getContext?.() ?? null; } catch (e) { return null; } }
    function S() {
        const c = ctx(); if (!c) return { ...DEFAULTS };
        const es = c.extensionSettings; if (!es[NAME]) es[NAME] = {};
        const s = es[NAME];
        for (const k of Object.keys(DEFAULTS)) if (s[k] === undefined) s[k] = DEFAULTS[k];
        return s;
    }
    function saveSettings() { try { ctx()?.saveSettingsDebounced?.(); } catch (e) { /* ignore */ } }
    function log(...a) { try { if (S().debug) console.log(LOG, ...a); } catch (e) { /* ignore */ } }
    function warn(...a) { try { console.warn(LOG, ...a); } catch (e) { /* ignore */ } }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function waitFor(fn, timeout = 300000, step = 300) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            (function tick() {
                try { const v = fn(); if (v) return resolve(v); } catch (e) { /* ignore */ }
                if (Date.now() - t0 > timeout) return resolve(null);
                setTimeout(tick, step);
            })();
        });
    }
    function hash(str) {
        let h = 5381;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(16);
    }
    function splitTags(text) {
        return String(text || '').split(/[,，；;。]/).map((x) => x.trim()).filter(Boolean);
    }
    // 只保留能当 SD tag 用的短标签（滤掉中文/长句，避免兜底提示词混入中文被闸门拦下）
    function cleanTagList(tags) {
        const out = [];
        for (const raw of (tags || [])) {
            for (const t of splitTags(raw)) {
                if (!t) continue;
                if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(t)) continue;
                if (t.length > 64) continue;
                if (!out.includes(t)) out.push(t);
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- 全局核心表（v1.1.0）
    // 设计：外观标签是「角色级」而不是「聊天级」的，所以核心表放扩展设置里全局共享；
    // 每个角色记录 tags / 来源 / 时间，自动维护时按来源优先级合并。
    function aliasMap() {
        const a = S().aliases;
        return (a && typeof a === 'object' && !Array.isArray(a)) ? a : {};
    }
    const TAG_DIM_RE = /(breasts?|hair|eyes?|ears?|tail|height|skin|horns?|wings?|legs?|feet|hands?|figure|muscle)$/i;

    function tagDimension(tag) {
        const m = String(tag || '').trim().match(TAG_DIM_RE);
        return m ? m[1].toLowerCase() : '';
    }
    function canonicalName(name) {
        const n = String(name || '').replace(/[（(].*$/, '').trim();
        if (!n) return '';
        return aliasMap()[n] || n;
    }
    // 加入标签：去重（忽略大小写）+ 同维度冲突只保留先到的（高优先级来源先合并）
    function pushTag(list, tag, max) {
        const t = String(tag || '').trim();
        if (!t || t.length > 64) return false;
        if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(t)) return false;
        const low = t.toLowerCase();
        if (list.some((x) => String(x).toLowerCase() === low)) return false;
        if (list.length >= max) return false;
        const dim = tagDimension(t);
        if (dim && list.some((x) => tagDimension(x) === dim)) return false;
        list.push(t);
        return true;
    }
    function mergeLayer(target, map, source, max) {
        for (const [rawName, rawTags] of Object.entries(map || {})) {
            const name = canonicalName(rawName);
            if (!name) continue;
            const tags = cleanTagList(rawTags);
            if (!tags.length) continue;
            if (!target[name]) target[name] = { tags: [], sources: [] };
            const entry = target[name];
            for (const t of tags) pushTag(entry.tags, t, max);
            if (!entry.sources.includes(source)) entry.sources.push(source);
        }
    }
    function store() {
        const s = S();
        if (!s.coreStore || typeof s.coreStore !== 'object' || Array.isArray(s.coreStore)) s.coreStore = {};
        const st = s.coreStore;
        if (typeof st.version !== 'number') st.version = 1;
        if (typeof st.updatedAt !== 'number') st.updatedAt = 0;
        if (typeof st.booksFetchedAt !== 'number') st.booksFetchedAt = 0;
        if (typeof st.fingerprint !== 'string') st.fingerprint = '';
        if (!st.chars || typeof st.chars !== 'object' || Array.isArray(st.chars)) st.chars = {};
        if (!st.bookChars || typeof st.bookChars !== 'object' || Array.isArray(st.bookChars)) st.bookChars = {};
        if (!Array.isArray(st.books)) st.books = [];
        return st;
    }
    function currentCard() {
        try {
            const c = ctx();
            if (!c) return null;
            const arr = c.characters;
            if (Array.isArray(arr)) return arr[c.characterId] || null;
            if (arr && typeof arr === 'object') return Object.values(arr)[c.characterId] || null;
            return null;
        } catch (e) { return null; }
    }
    function currentScopeId() {
        try {
            const c = ctx();
            return String(c.chatMetadata?.sd_npc_scope_id || '').trim();
        } catch (e) { return ''; }
    }
    // 外观档案条目带【对话ID】，只吸收当前聊天 scope 的；全局条目（无 ID）始终吸收。
    function entryBelongsToCurrentScope(content) {
        const m = String(content || '').match(/【对话ID】\s*([A-Za-z0-9_-]+)/);
        if (!m) return true;
        const scope = currentScopeId();
        if (!scope) return false;
        return m[1].trim() === scope;
    }
    function currentFingerprint() {
        try {
            const c = ctx();
            if (!c) return '';
            const ch = currentCard();
            const card = ch?.data || {};
            const cardText = [c.characterId, ch?.name, card.description, card.personality, card.scenario,
                card.mes_example, card.system_prompt, card.post_history_instructions,
                card.extensions?.depth_prompt?.prompt].join('\u0001');
            const pu = c.powerUserSettings || {};
            const personaText = [pu.persona_name, pu.persona_description, c.name1].join('\u0001');
            let app = '';
            try { app = JSON.stringify(window.__DSH_APPEARANCE_TAGS_GET?.() || {}); } catch (e) { /* ignore */ }
            return hash([cardText, personaText, app].join('\u0002'));
        } catch (e) { return ''; }
    }
    // 写词/兜底/一致性合并统一从这里取角色标签：全局核心表 + 旧版聊天内核心表（兼容）
    function coreTagsFor(name) {
        const out = [];
        const st = store();
        const wanted = [String(name || '').trim()];
        const alias = aliasMap()[wanted[0]];
        if (alias && !wanted.includes(alias)) wanted.push(alias);
        const legacy = meta(ctx()).core || {};
        for (const n of wanted) {
            const entry = st.chars?.[n];
            const lists = [];
            if (entry && Array.isArray(entry.tags)) lists.push(entry.tags);
            if (Array.isArray(legacy[n])) lists.push(cleanTagList(legacy[n]));
            for (const tags of lists) {
                for (const t of tags) {
                    if (!out.some((x) => String(x).toLowerCase() === String(t).toLowerCase())) out.push(t);
                }
            }
        }
        return out;
    }
    // 把核心表镜像到 ST 全局变量，世界书/人格可用 {{getvar::dsh_ps_core}} / {{getvar::dsh_core_<角色名>}}
    function mirrorCoreVariables() {
        try {
            const c = ctx();
            const g = c?.variables?.global;
            if (!g || typeof g.set !== 'function') return;
            const st = store();
            const simple = {};
            for (const [n, e] of Object.entries(st.chars || {})) simple[n] = (e?.tags || []).slice();
            g.set('dsh_ps_core', JSON.stringify(simple));
            g.set('dsh_ps_core_updated', String(st.updatedAt || 0));
            for (const [n, tags] of Object.entries(simple)) {
                try { g.set('dsh_core_' + n, tags.join(', ')); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    }

    // ---------------------------------------------------------------- 状态（变量对象 8）
    function meta(c) {
        const cc = c || ctx();
        if (!cc) return { state: {}, cache: [], core: {} };
        if (!cc.chatMetadata) cc.chatMetadata = {};
        if (!cc.chatMetadata.__dsh_ps || typeof cc.chatMetadata.__dsh_ps !== 'object') {
            cc.chatMetadata.__dsh_ps = { state: {}, cache: [], core: {} };
        }
        const m = cc.chatMetadata.__dsh_ps;
        if (!m.state) m.state = {};
        if (!Array.isArray(m.cache)) m.cache = [];
        if (!m.core || typeof m.core !== 'object') m.core = {};
        return m;
    }
    function mirrorVariables() {
        // 把关键状态镜像到 ST 聊天变量，便于世界书/人格/其他扩展用 {{getvar::...}} 读取
        try {
            const c = ctx(); if (!c) return;
            const m = meta(c);
            const set = c.variables?.local?.set;
            if (typeof set !== 'function') return;
            set('dsh_ps_scene', String(m.state.scene || ''));
            set('dsh_ps_cast', JSON.stringify(m.state.cast || {}));
            set('dsh_ps_camera', String(m.state.camera || ''));
            set('dsh_ps_last', String(m.state.lastPrompt || ''));
        } catch (e) { /* ignore */ }
    }
    function saveMeta() {
        try { ctx()?.saveMetadataDebounced?.(); } catch (e) { /* ignore */ }
        mirrorVariables();
    }

    // ---------------------------------------------------------------- 条件宏模板（7）
    // 支持 {{if name}}…{{else}}…{{/if}}（可嵌套）、{{name}} 替换；未知 token 替换成空。
    function renderTemplate(tpl, vars) {
        const src = String(tpl ?? '');
        // 先做 token 化，再递归处理 if 块
        function findBlockEnd(start) {
            // start 指向 {{if ...}} 之后；返回匹配的 {{/if}} 位置
            let depth = 1, i = start;
            const re = /{{\s*(\/if|if\s+[^}]+)\s*}}/g;
            re.lastIndex = start;
            let m;
            while ((m = re.exec(src))) {
                if (m[1].startsWith('if')) depth++;
                else { depth--; if (depth === 0) return { ifEnd: m.index, closeEnd: m.index + m[0].length }; }
            }
            return null;
        }
        function renderRange(text) {
            let out = '';
            let i = 0;
            while (i < text.length) {
                const open = text.indexOf('{{', i);
                if (open < 0) { out += text.slice(i); break; }
                out += text.slice(i, open);
                const close = text.indexOf('}}', open + 2);
                if (close < 0) { out += text.slice(open); break; }
                const inner = text.slice(open + 2, close).trim();
                if (inner.startsWith('if ')) {
                    const cond = inner.slice(3).trim();
                    const innerStart = close + 2;
                    let depth = 1, j = innerStart, elsePos = -1, endPos = -1, endLen = 0;
                    const re = /{{\s*(\/if|else|if\s+[^}]+)\s*}}/g;
                    re.lastIndex = innerStart;
                    let m;
                    while ((m = re.exec(text))) {
                        if (m[1] === 'else') { if (depth === 1 && elsePos < 0) elsePos = m.index; }
                        else if (m[1].startsWith('if')) depth++;
                        else { depth--; if (depth === 0) { endPos = m.index; endLen = m[0].length; break; } }
                    }
                    if (endPos < 0) { out += text.slice(open, close + 2); i = close + 2; continue; }
                    const truePart = text.slice(innerStart, elsePos >= 0 ? elsePos : endPos);
                    const falsePart = elsePos >= 0 ? text.slice(elsePos + '{{else}}'.length, endPos) : '';
                    out += renderRange(!!vars[cond] ? truePart : falsePart);
                    i = endPos + endLen;
                } else if (inner === 'else' || inner === '/if') {
                    // 不配对时忽略
                    i = close + 2;
                } else {
                    out += (vars[inner] !== undefined && vars[inner] !== null) ? String(vars[inner]) : '';
                    i = close + 2;
                }
            }
            return out;
        }
        return renderRange(src);
    }

    // ---------------------------------------------------------------- 外观档案解析
    // 档案行格式（sd-appearance）：`- 名字（...）：tag1, tag2, ...`
    function parseAppearanceBlock(block) {
        const order = [];
        const map = {};
        const lines = String(block || '').split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*-\s*([^（(]+?)\s*[（(][^）)]*[）)]\s*[：:]\s*(.+)$/);
            if (!m) continue;
            const name = m[1].trim();
            if (!name) continue;
            const tags = cleanTagList(splitTags(m[2]));
            if (!tags.length) continue;
            if (!map[name]) { map[name] = []; order.push(name); }
            for (const t of tags) if (!map[name].includes(t)) map[name].push(t);
        }
        return { order, map };
    }

    // ---------------------------------------------------------------- 规则兜底
    function cameraTags(angle) {
        if (angle === 'scene') return ['wide shot', 'full body', 'wide angle'];
        if (angle === 'closeup') return ['close-up', 'portrait', 'upper body'];
        return [];
    }
    function fallbackTags({ appearanceBlock, angleHint, reason } = {}) {
        try {
            const c = ctx();
            const m = meta(c);
            const app = parseAppearanceBlock(appearanceBlock);
            const names = (app.order.length ? app.order : Object.keys(m.state.cast || {})).slice(0, 4);
            const count = Math.max(1, names.length);
            const global = [];
            if (count === 1) { global.push('1girl', 'solo'); }
            else if (count === 2) { global.push('2girls', 'multiple girls'); }
            else { global.push(`${count}girls`, 'multiple girls', 'group'); }
            global.push(...cameraTags(angleHint));
            if (m.state.scene) global.push(...cleanTagList(splitTags(m.state.scene)).slice(0, 30));
            if (!m.state.scene) global.push('indoors', 'soft lighting');
            const segs = [global.join(', ')];
            for (const name of names) {
                const tags = [];
                const core = coreTagsFor(name);
                for (const t of core) if (!tags.includes(t)) tags.push(t);
                for (const t of (app.map[name] || [])) if (!tags.includes(t)) tags.push(t);
                if (!tags.length) tags.push('1girl', 'solo');
                segs.push(`${name}：${tags.join(', ')}`);
            }
            // 没有角色时，退回上一张成功提示词
            if (!names.length && m.state.lastPrompt) return String(m.state.lastPrompt);
            const out = segs.join(' | ');
            log('fallbackTags', reason || '', out.slice(0, 200));
            return out;
        } catch (e) {
            warn('fallbackTags failed', e);
            return '';
        }
    }

    // ---------------------------------------------------------------- 一致性合并
    function mergeConsistency(text, appearanceBlock) {
        if (!S().consistency) return String(text || '');
        try {
            const c = ctx();
            const m = meta(c);
            const app = parseAppearanceBlock(appearanceBlock);
            const parts = String(text || '').split('|').map((x) => x.trim()).filter(Boolean);
            if (!parts.length) return String(text || '');
            const isCharSeg = (s) => /^[^:：]{1,20}[：:]/.test(s);
            const out = [];
            for (const seg of parts) {
                if (!isCharSeg(seg)) { out.push(seg); continue; }
                const idx = seg.search(/[：:]/);
                const name = seg.slice(0, idx).trim();
                let tags = seg.slice(idx + 1).split(',').map((x) => x.trim()).filter(Boolean);
                const core = coreTagsFor(name);
                const appTags = app.map[name] || [];
                const wanted = [...core, ...appTags].filter(Boolean);
                let added = 0;
                for (const t of wanted) {
                    if (tags.includes(t)) continue;
                    // 同一维度冲突时（例如已有 huge breasts）不再追加外观档案里的同类标签
                    const dim = t.match(/(breasts|hair|eyes|ears|tail|height|skin)$/i);
                    if (dim && tags.some((x) => new RegExp(dim[1] + '$', 'i').test(x))) continue;
                    tags.push(t);
                    added++;
                    if (added > 30) break;
                }
                out.push(`${name}：${tags.join(', ')}`);
            }
            return out.join(' | ');
        } catch (e) {
            warn('mergeConsistency failed', e);
            return String(text || '');
        }
    }

    // ---------------------------------------------------------------- 状态解析
    function updateStateFromText(text, angleHint, appearanceBlock, cacheKey) {
        try {
            const c = ctx();
            const m = meta(c);
            const parts = String(text || '').split('|').map((x) => x.trim()).filter(Boolean);
            const cast = {};
            const global = [];
            for (const seg of parts) {
                const idx = seg.search(/[：:]/);
                const isChar = idx > 0 && idx <= 20;
                if (isChar) cast[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
                else global.push(seg);
            }
            m.state = m.state || {};
            m.state.scene = global.join(', ').slice(0, 800);
            m.state.cast = cast;
            m.state.camera = angleHint ? cameraTags(angleHint).join(', ') : '';
            m.state.lastPrompt = String(text || '').slice(0, 2000);
            m.state.updated = Date.now();
            // 缓存
            if (S().cache) {
                m.cache = (m.cache || []).filter((x) => x.key !== cacheKey && Date.now() - x.ts < S().cacheMs);
                m.cache.unshift({ key: cacheKey, text: String(text || '').slice(0, 2000), scene: m.state.scene, cast, ts: Date.now() });
                m.cache = m.cache.slice(0, 6);
            }
            saveMeta();
        } catch (e) { warn('updateState failed', e); }
    }

    // ---------------------------------------------------------------- 写词主入口
    async function writePrompt({ quietPrompt, generationType, appearanceBlock, angleHint } = {}) {
        const s = S();
        const c = ctx();
        if (!c) return '';
        // v1.1.0：写词前先确认核心表不过期（纯本地读卡/人格/外观，不调 LLM）
        await ensureCoreForWrite();
        const chat = c.chat || [];
        const recent = chat.filter((x) => !x.is_system).slice(-3)
            .map((x) => `${x.name || (x.is_user ? 'user' : 'char')}: ${String(x.mes || '').slice(0, 800)}`).join('\n');
        const m = meta(c);
        const app = parseAppearanceBlock(appearanceBlock);
        const names = app.order.slice(0, 4);
        // 缓存 key 只用稳定输入（聊天 + 最近正文 + 外观档案 + 镜头 + 生成类型），
        // 不能带可变状态（如 lastPrompt 长度），否则永远不命中。
        const key = hash([c.chatId, recent, appearanceBlock || '', angleHint || '', generationType, names.join(',')].join('|'));

        // 缓存命中：直接复用（同一批内容 + 同一镜头）
        if (s.cache) {
            const hit = (m.cache || []).find((x) => x.key === key && Date.now() - x.ts < s.cacheMs && x.text);
            if (hit) { log('cache hit', key); return hit.text; }
        }

        const vars = {
            multi: names.length >= 2,
            single: names.length < 2,
            angle_scene: angleHint === 'scene',
            angle_closeup: angleHint === 'closeup',
            background: generationType === (window.generationMode?.BACKGROUND ?? 3),
            people: String(names.length),
        };
        let instruction = '';
        if (s.useTemplate) instruction = renderTemplate(s.template || DEFAULT_TEMPLATE, vars);
        else instruction = String(quietPrompt || '');
        instruction = instruction.trim();
        if (angleHint) {
            const hints = window.__DSH_SD_ANGLE_HINTS || {};
            if (hints[angleHint]) instruction += '\n' + hints[angleHint];
        }
        const promptParts = [instruction];
        if (appearanceBlock) promptParts.push(appearanceBlock);
        if (recent) promptParts.push('【Latest chat (extract visuals only)】\n' + recent);
        const rawPrompt = promptParts.join('\n\n');
        const rawSystem = 'You are a Stable Diffusion prompt writer. Output ONLY one line of comma-separated English danbooru-style tags. Never write story, dialogue, explanations, markup, XML or table edits.';
        const oai = c.chatCompletionSettings || null;
        const prevEffort = oai ? oai.reasoning_effort : undefined;
        if (oai) oai.reasoning_effort = 'min';
        let text = '';
        try {
            const ask = async (len) => {
                if (typeof c.generateRaw !== 'function') throw new Error('generateRaw unavailable');
                const t0 = performance.now();
                const out = String(await c.generateRaw({ prompt: rawPrompt, systemPrompt: rawSystem, responseLength: len }) || '');
                log('writePrompt llm', Math.round(performance.now() - t0) + 'ms len', out.length);
                return out;
            };
            try { text = await ask(3072); } catch (e) { warn('writePrompt first ask failed', e); text = ''; }
            if (!String(text).trim()) text = await ask(6144);
        } catch (e) {
            warn('writePrompt LLM failed, fallback', e);
        } finally {
            if (oai && prevEffort !== undefined) oai.reasoning_effort = prevEffort;
        }
        if (!String(text).trim() && s.fallback) {
            text = fallbackTags({ appearanceBlock, angleHint, reason: 'llm-empty' });
        }
        text = mergeConsistency(text, appearanceBlock);
        updateStateFromText(text, angleHint, appearanceBlock, key);
        // 出图链路（sd-appearance 会在 finalize 时更新外观标签）之后再做一次便宜的指纹复查
        if (s.autoMaintain && s.autoOnSourceChange) {
            setTimeout(() => { try { if (needsRefresh()) scheduleAuto('source', 800); } catch (e) { /* ignore */ } }, 5000);
        }
        return String(text || '');
    }

    // ---------------------------------------------------------------- 角色书 / 人格书（9）
    function extractSdTags(text) {
        const tags = [];
        const s = String(text || '');
        const re = /【SD[^】]*】\s*[：:]?\s*([^\n【]+)/g;
        let m;
        while ((m = re.exec(s))) {
            for (const t of splitTags(m[1])) if (!tags.includes(t)) tags.push(t);
        }
        return tags;
    }
    function extractBlockLines(text) {
        const out = {};
        for (const line of String(text || '').split('\n')) {
            const m = line.match(/^\s*-\s*([^（(]+?)\s*[（(][^）)]*[）)]\s*[：:]\s*(.+)$/);
            if (m) out[m[1].trim()] = splitTags(m[2]);
        }
        return out;
    }
    async function fetchBookEntries(bookName) {
        try {
            const c = ctx();
            const r = await fetch('/api/worldinfo/get', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ name: bookName }) });
            if (!r.ok) return [];
            const j = await r.json();
            // 1.19 的条目带 comment（= 角色名）与 content（= 标签），两样都要
            return Object.values(j.entries || {}).map((e) => ({
                comment: String(e.comment || (Array.isArray(e.key) ? e.key[0] : '') || ''),
                content: String(e.content || ''),
            }));
        } catch (e) { return []; }
    }
    // 1.19 的 executeSlashCommandsWithOptions 返回 {pipe} 对象，pipe 才是命令结果字符串
    function slashPipe(r) {
        if (typeof r === 'string') return r;
        if (r && typeof r === 'object' && typeof r.pipe === 'string') return r.pipe;
        return '';
    }
    async function resolveBookNames(c) {
        const books = [];
        const push = (x) => {
            const n = typeof x === 'string' ? x.trim().replace(/^"|"$/g, '') : (x && typeof x === 'object' ? String(x.name || x.book || '').trim() : '');
            if (n && n !== '[object Object]' && n !== '[]' && n !== '""' && !books.includes(n)) books.push(n);
        };
        // 1) 配置的外观世界书（扩展设置 appearanceBooks，逗号分隔）；留空则只靠 2)/3) 的绑定书
        try {
            const configured = Array.isArray(S().appearanceBooks) ? S().appearanceBooks : [];
            if (configured.length) {
                const worldNames = c.getWorldInfoNames?.() || [];
                for (const n of worldNames) {
                    const t = String(n || '').trim();
                    if (!t) continue;
                    if (configured.some((x) => t === x || t.startsWith(String(x)))) push(t);
                }
            }
        } catch (e) { /* ignore */ }
        // 2) 角色绑定的书（1.19 命令返回 {pipe}）
        try {
            const pipe = slashPipe(await c.executeSlashCommandsWithOptions('/getcharbook type=all')).trim();
            if (pipe.startsWith('[')) {
                try { for (const x of JSON.parse(pipe)) push(x); } catch (e) { for (const x of pipe.replace(/[\[\]"]/g, '').split(',')) push(x); }
            } else if (pipe && pipe !== '[]' && pipe !== '[object Object]') push(pipe);
        } catch (e) { /* ignore */ }
        // 3) 人格绑定的书
        try {
            const pipe = slashPipe(await c.executeSlashCommandsWithOptions('/getpersonabook')).trim();
            if (pipe && pipe !== '[]' && pipe !== '[object Object]') push(pipe);
        } catch (e) { /* ignore */ }
        return books.slice(0, 8);
    }
    async function refreshBookChars(st, force) {
        const c = ctx();
        if (!c) return { ok: false, cached: true, books: st.books || [] };
        const s = S();
        const fresh = !!force || Date.now() - (st.booksFetchedAt || 0) >= Math.max(60000, Number(s.bookRefreshMs) || 0) || !st.books?.length;
        if (!fresh) return { ok: true, cached: true, books: st.books || [] };
        const books = await resolveBookNames(c);
        if (!books.length) return { ok: false, cached: false, books: st.books || [] };
        const parsed = {};
        for (const b of books) {
            let entries = [];
            try { entries = await fetchBookEntries(b); } catch (e) { entries = []; }
            for (const entry of entries) {
                const content = typeof entry === 'string' ? entry : String(entry?.content || '');
                const comment = typeof entry === 'string' ? '' : String(entry?.comment || '');
                if (!content) continue;
                if (!entryBelongsToCurrentScope(content)) continue;
                // 说明条目（_使用说明 / 含“这个书不是给聊天用的”）不是角色，直接跳过
                if (/^_/.test(comment.trim()) || /这个书不是给聊天用的/.test(content.slice(0, 60))) continue;
                for (const [n, tags] of Object.entries(extractBlockLines(content))) {
                    const name = canonicalName(n);
                    if (!name) continue;
                    if (!parsed[name]) parsed[name] = [];
                    for (const t of cleanTagList(tags)) if (!parsed[name].includes(t)) parsed[name].push(t);
                }
                const sd = cleanTagList(extractSdTags(content));
                let tags = sd;
                // 有的条目内容就是一行英文标签（没有【SD标签】前缀）
                if (!tags.length) {
                    const firstLine = content.split('\n').map((x) => x.trim()).find(Boolean) || '';
                    if (firstLine && !/[\u4e00-\u9fff\u3040-\u30ff]/.test(firstLine) && /,/.test(firstLine)) tags = cleanTagList(firstLine);
                }
                if (!tags.length) continue;
                // 角色名优先用条目标题（comment），标题里常见“角色：X”前缀
                let name = canonicalName(comment.replace(/^角色[：:]\s*/, ''));
                if (!name) {
                    name = canonicalName(content.split('\n')[0].replace(/【.*?】/g, '').replace(/^[·\-\s]+/, '').replace(/[：:].*$/, '').trim().slice(0, 20));
                }
                if (!name) continue;
                if (!parsed[name]) parsed[name] = [];
                for (const t of tags) if (!parsed[name].includes(t)) parsed[name].push(t);
            }
        }
        if (!Object.keys(parsed).length) return { ok: false, cached: false, books: st.books || [] };
        st.bookChars = parsed;
        st.books = books;
        st.booksFetchedAt = Date.now();
        return { ok: true, cached: false, books };
    }

    // 全局核心表重建：角色卡/人格 > 世界书/角色书 > sd-appearance 外观标签
    // mode: manual（全量拉书）/ auto（按 TTL 拉书）/ prewrite（只读缓存，绝不阻塞写词）
    let rebuildPromise = null;
    async function rebuildCore(opts = {}) {
        if (rebuildPromise) return rebuildPromise;
        const mode = opts.mode || 'manual';
        rebuildPromise = (async () => {
            const t0 = performance.now();
            const c = ctx();
            if (!c) return { ok: false, msg: 'no context' };
            const s = S();
            const st = store();
            // 书内容：manual 强拉；auto 按最短间隔拉；prewrite 只用缓存（避免写词被读盘卡住）
            if (s.autoBookRefresh !== false && mode !== 'prewrite') {
                try { await refreshBookChars(st, opts.forceBook || mode === 'manual'); } catch (e) { warn('refreshBookChars failed', e); }
            }
            const maxTags = Math.max(5, Number(s.maxTagsPerChar) || 40);
            const merged = {};
            // 1) 当前角色卡（最高优先级）
            try {
                const ch = currentCard();
                const card = ch?.data || {};
                const cardTexts = [card.description, card.personality, card.scenario, card.mes_example,
                    card.system_prompt, card.post_history_instructions,
                    card.extensions?.depth_prompt?.prompt].filter(Boolean).join('\n');
                const cardMap = {};
                const cardTags = cleanTagList(extractSdTags(cardTexts));
                if (ch?.name && cardTags.length) cardMap[ch.name] = cardTags.slice();
                for (const [n, tags] of Object.entries(extractBlockLines(cardTexts))) {
                    if (!cardMap[n]) cardMap[n] = [];
                    for (const t of cleanTagList(tags)) if (!cardMap[n].includes(t)) cardMap[n].push(t);
                }
                mergeLayer(merged, cardMap, 'card', maxTags);
            } catch (e) { /* ignore */ }
            // 2) 当前人格
            try {
                const pu = c.powerUserSettings || {};
                const persona = String(pu.persona_description || '');
                const pname = canonicalName(pu.persona_name || c.name1 || 'User') || 'User';
                const personaMap = {};
                const pTags = cleanTagList(extractSdTags(persona));
                if (pTags.length) personaMap[pname] = pTags.slice();
                for (const [n, tags] of Object.entries(extractBlockLines(persona))) {
                    const name = canonicalName(n);
                    if (!name) continue;
                    if (!personaMap[name]) personaMap[name] = [];
                    for (const t of cleanTagList(tags)) if (!personaMap[name].includes(t)) personaMap[name].push(t);
                }
                mergeLayer(merged, personaMap, 'persona', maxTags);
            } catch (e) { /* ignore */ }
            // 3) 世界书/角色书（已按当前聊天 scope 过滤）
            try {
                const bookMap = {};
                for (const [n, tags] of Object.entries(st.bookChars || {})) bookMap[n] = cleanTagList(tags);
                mergeLayer(merged, bookMap, 'book', maxTags);
            } catch (e) { /* ignore */ }
            // 4) sd-appearance 已整理好的外观标签（最低优先级，只补缺）
            try {
                if (typeof window.__DSH_APPEARANCE_TAGS_GET === 'function') {
                    const map = window.__DSH_APPEARANCE_TAGS_GET() || {};
                    const appMap = {};
                    for (const [n, tags] of Object.entries(map)) appMap[n] = cleanTagList(tags);
                    mergeLayer(merged, appMap, 'appearance', maxTags);
                }
            } catch (e) { /* ignore */ }
            // 合并进全局表：本次出现的角色刷新；没出现的保留（超过 pruneDays 才清）
            const chars = {};
            const now = Date.now();
            const pruneMs = Math.max(1, Number(s.pruneDays) || 30) * 24 * 3600 * 1000;
            for (const [name, e] of Object.entries(st.chars || {})) {
                if (e && Array.isArray(e.tags) && now - (Number(e.ts) || 0) < pruneMs) chars[name] = e;
            }
            for (const [name, e] of Object.entries(merged)) {
                chars[name] = { tags: e.tags.slice(0, maxTags), sources: e.sources.slice(), ts: now };
            }
            st.chars = chars;
            st.updatedAt = now;
            st.fingerprint = currentFingerprint();
            saveSettings();
            mirrorCoreVariables();
            const names = Object.keys(chars);
            const counts = Object.fromEntries(names.map((n) => [n, (chars[n].tags || []).length]));
            const ms = Math.round(performance.now() - t0);
            const msg = `核心标签：${names.map((n) => n + '(' + counts[n] + ')').join('、') || '无'}；书：${(st.books || []).join('、') || '无'}；${ms}ms`;
            log('rebuildCore', mode, msg);
            return { ok: true, mode, names, counts, books: st.books || [], sources: Object.fromEntries(names.map((n) => [n, chars[n].sources])), ms, msg };
        })();
        try { return await rebuildPromise; } finally { rebuildPromise = null; }
    }

    // ---------------------------------------------------------------- 自动维护调度（v1.1.0）
    let autoTimer = null;
    let checkTimer = null;
    let aiMsgCount = 0;
    function needsRefresh({ bookDirty = false } = {}) {
        try {
            const s = S();
            const st = store();
            if (!Object.keys(st.chars || {}).length) return true;
            if (bookDirty) return true;
            if (s.autoOnSourceChange !== false && st.fingerprint !== currentFingerprint()) return true;
            if (Date.now() - (st.updatedAt || 0) > Math.max(60 * 1000, Number(s.coreMaxAgeMs) || 0)) return true;
            return false;
        } catch (e) { return false; }
    }
    function scheduleAuto(reason, delay = 800, opts = {}) {
        try {
            const s = S();
            if (!s.enabled || !s.autoMaintain) return;
            if (reason === 'chat' && !s.autoOnChatChange) return;
            if ((reason === 'source' || reason === 'everyN') && !s.autoOnSourceChange) return;
            if (autoTimer) clearTimeout(autoTimer);
            autoTimer = setTimeout(() => { autoTimer = null; runAuto(reason, opts); }, Math.max(100, Number(delay) || 800));
        } catch (e) { /* ignore */ }
    }
    function booksMissing() {
        try {
            const s = S();
            if (s.autoBookRefresh === false) return false;
            return !(store().books || []).length;
        } catch (e) { return false; }
    }
    async function runAuto(reason, opts = {}) {
        try {
            const s = S();
            if (!s.enabled || !s.autoMaintain) return;
            const wantBooks = booksMissing();
            if (!needsRefresh({ bookDirty: !!opts.bookDirty }) && !wantBooks) { log('auto skip', reason); updatePanelStatus(); return; }
            const r = await rebuildCore({ mode: 'auto', forceBook: !!opts.bookDirty || wantBooks });
            log('auto rebuild', reason, r.msg);
            updatePanelStatus();
            // 自动重建后 8 秒再查一次指纹：角色卡/外观/书可能有异步更新（sd-appearance 建档等）
            if (S().autoOnSourceChange) {
                setTimeout(() => { try { if (S().autoMaintain && needsRefresh()) scheduleAuto('source', 800); } catch (e) { /* ignore */ } }, 8000);
            }
        } catch (e) { warn('auto rebuild failed', e); }
    }
    // 写词前兜底：核心表为空/指纹变了/过期 → 先本地重建（不调大模型、不拉书）
    async function ensureCoreForWrite() {
        try {
            const s = S();
            if (!s.enabled || !s.autoMaintain) return;
            if (!needsRefresh()) return;
            const r = await rebuildCore({ mode: 'prewrite' });
            log('pre-write refresh', r.msg);
            updatePanelStatus();
            // prewrite 不拉书（不阻塞写词），但书如果还是空的，几秒后后台补上
            if (booksMissing()) {
                setTimeout(() => scheduleAuto('source', 1200), 3000);
            }
        } catch (e) { warn('pre-write refresh failed', e); }
    }
    function startAutoTimer() {
        if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
        try {
            const s = S();
            if (!s.enabled || !s.autoMaintain || !s.autoOnSourceChange) return;
            const ms = Math.max(10 * 1000, Number(s.autoCheckMs) || 60000);
            checkTimer = setInterval(() => {
                try {
                    const s2 = S();
                    if (!s2.enabled || !s2.autoMaintain || !s2.autoOnSourceChange) return;
                    if (needsRefresh() || booksMissing()) scheduleAuto('source', 1200);
                } catch (e) { /* ignore */ }
            }, ms);
        } catch (e) { /* ignore */ }
    }
    function coreStoreSummary() {
        const st = store();
        const names = Object.keys(st.chars || {});
        const total = names.reduce((a, n) => a + ((st.chars[n]?.tags || []).length), 0);
        return { names, total, books: st.books || [], updatedAt: st.updatedAt || 0, fingerprint: st.fingerprint || '' };
    }
    function fmtTime(ts) {
        try { return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '从未'; } catch (e) { return '从未'; }
    }
    function updatePanelStatus(extra) {
        try {
            const box = document.getElementById('ps-core-info');
            if (!box) return;
            const s = S();
            const st = store();
            const sum = coreStoreSummary();
            const detail = sum.names.slice(0, 6).map((n) => n + '(' + ((st.chars[n]?.tags || []).length) + ')').join('、');
            const books = sum.books.slice(0, 3).join('、') || '无';
            const on = s.autoMaintain
                ? `开（切聊天${s.autoOnChatChange ? '✓' : '✗'} / 变化${s.autoOnSourceChange ? '✓' : '✗'} / 每${s.autoEveryN}条）`
                : '关';
            box.textContent = [
                `核心：${detail || '无'} ｜ 共 ${sum.names.length} 人 ${sum.total} 标签 ｜ 更新 ${fmtTime(sum.updatedAt)} ｜ 指纹 ${(sum.fingerprint || '-').slice(0, 8)}`,
                `书籍：${books} ｜ 自动维护：${on}`,
                extra ? String(extra) : '',
            ].filter(Boolean).join('\n');
        } catch (e) { /* ignore */ }
    }
    // 旧版（v1.0.0）把核心表存在每个聊天的 chatMetadata 里，升级后先搬进全局表
    function migrateLegacyCore() {
        try {
            const st = store();
            if (Object.keys(st.chars || {}).length) return;
            const legacy = meta(ctx()).core || {};
            const names = Object.keys(legacy);
            if (!names.length) return;
            for (const n of names) {
                const tags = cleanTagList(legacy[n]);
                if (!tags.length) continue;
                st.chars[canonicalName(n) || n] = { tags, sources: ['legacy-chat'], ts: Date.now() };
            }
            st.updatedAt = Date.now();
            st.fingerprint = '';
            saveSettings();
            log('migrate legacy core', Object.keys(st.chars));
        } catch (e) { /* ignore */ }
    }

    // ---------------------------------------------------------------- 思考块折叠（10）
    function collapseReasoning() {
        try {
            for (const d of document.querySelectorAll('details.mes_reasoning_details[open]')) d.removeAttribute('open');
        } catch (e) { /* ignore */ }
    }
    let collapseTimer = null;
    function scheduleCollapse() {
        if (!S().autoCollapseReasoning) return;
        if (collapseTimer) clearTimeout(collapseTimer);
        collapseTimer = setTimeout(collapseReasoning, 400);
    }

    // ---------------------------------------------------------------- 面板
    function buildPanel() {
        if (document.getElementById(NAME + '-panel')) return;
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host) return;
        const s = S();
        const div = document.createElement('div');
        div.id = NAME + '-panel';
        div.innerHTML = `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>DSH 写词稳定器 v${VERSION}</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" id="ps-enabled"> 启用（写词缓存/一致性/兜底）</label>
    <label class="checkbox_label"><input type="checkbox" id="ps-cache"> 写词缓存（同一场景复用上次提示词）</label>
    <label class="checkbox_label"><input type="checkbox" id="ps-consistency"> 一致性合并（把外观档案的稳定标签补进角色段）</label>
    <label class="checkbox_label"><input type="checkbox" id="ps-fallback"> 规则兜底（写词失败也出图）</label>
    <label class="checkbox_label"><input type="checkbox" id="ps-collapse"> 自动折叠思考块（推理块命令 10）</label>
    <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.14);">
      <b>自动维护外观核心标签</b>（v1.1.0，纯本地读取，不额外调大模型）
      <label class="checkbox_label"><input type="checkbox" id="ps-auto-maintain"> 自动维护（总开关）</label>
      <label class="checkbox_label"><input type="checkbox" id="ps-auto-chat"> 切换聊天时刷新</label>
      <label class="checkbox_label"><input type="checkbox" id="ps-auto-source"> 角色卡/人格/世界书/外观变化时刷新</label>
      <div class="flex-container flexGap5" style="flex-wrap:wrap;align-items:center;margin-top:4px;gap:8px;">
        <label>每 <input type="number" id="ps-auto-n" min="0" max="50" style="width:56px;"> 条 AI 回复刷新（0=关）</label>
        <label>检查间隔 <input type="number" id="ps-auto-check" min="10" max="600" style="width:64px;"> 秒</label>
        <label>最长有效期 <input type="number" id="ps-auto-maxage" min="1" max="720" style="width:64px;"> 分钟</label>
        <label>每角色上限 <input type="number" id="ps-auto-max" min="5" max="100" style="width:56px;"> 标签</label>
      </div>
    </div>
    <label class="checkbox_label"><input type="checkbox" id="ps-template"> 使用下面的条件宏写词模板</label>
    <label>写词模板（支持 {{if x}}…{{else}}…{{/if}} 嵌套、{{multi}} {{single}} {{angle_scene}} {{angle_closeup}} {{background}}）</label>
    <textarea id="ps-template-text" class="text_pole" rows="8" style="width:100%;box-sizing:border-box;font-size:12px;"></textarea>
    <label>外观世界书名单（逗号分隔；留空 = 只用角色卡/人格绑定的书）</label>
    <input type="text" id="ps-books-text" class="text_pole" style="width:100%;box-sizing:border-box;font-size:12px;">
    <label>角色别名（JSON，可空；例如 {"旁白":"Narrator"}）</label>
    <input type="text" id="ps-aliases-text" class="text_pole" style="width:100%;box-sizing:border-box;font-size:12px;">
    <div class="flex-container flexGap5" style="margin-top:6px;flex-wrap:wrap;align-items:center;">
      <div class="menu_button" id="ps-rebuild">立即重建核心标签（全量）</div>
      <div class="menu_button" id="ps-core-clear">清空核心表</div>
      <div class="menu_button" id="ps-core-copy">复制核心表 JSON</div>
      <div class="menu_button" id="ps-clearcache">清空本聊天写词缓存</div>
      <div class="menu_button" id="ps-collapse-now">折叠所有思考块</div>
    </div>
    <div id="ps-core-info" style="font-size:12px;opacity:.85;margin-top:6px;white-space:pre-wrap;line-height:1.5;"></div>
    <div id="ps-status" style="font-size:12px;opacity:.8;margin-top:4px;"></div>
  </div>
</div>`;
        host.appendChild(div);
        const st = () => div.querySelector('#ps-status');
        const bind = (id, key, type) => {
            const el = div.querySelector('#' + id);
            if (!el) return;
            if (type === 'bool') el.checked = !!s[key]; else el.value = s[key] ?? '';
            el.addEventListener(type === 'bool' ? 'change' : 'input', () => {
                s[key] = type === 'bool' ? !!el.checked : el.value;
                saveSettings();
            });
        };
        const bindAuto = (id, key) => {
            const el = div.querySelector('#' + id);
            if (!el) return;
            el.checked = s[key] !== false;
            el.addEventListener('change', () => {
                s[key] = !!el.checked;
                saveSettings();
                startAutoTimer();
                updatePanelStatus();
                if (s[key] && s.autoMaintain) scheduleAuto('settings', 800);
            });
        };
        const bindNum = (id, key, min, max, scale = 1) => {
            const el = div.querySelector('#' + id);
            if (!el) return;
            el.value = String(Math.round((Number(s[key]) || min * scale) / scale));
            el.addEventListener('change', () => {
                let v = Number(el.value);
                if (!Number.isFinite(v)) v = min;
                v = Math.max(min, Math.min(max, Math.round(v)));
                el.value = String(v);
                s[key] = v * scale;
                saveSettings();
                startAutoTimer();
                updatePanelStatus();
            });
        };
        bind('ps-enabled', 'enabled', 'bool');
        bind('ps-cache', 'cache', 'bool');
        bind('ps-consistency', 'consistency', 'bool');
        bind('ps-fallback', 'fallback', 'bool');
        bind('ps-collapse', 'autoCollapseReasoning', 'bool');
        bind('ps-template', 'useTemplate', 'bool');
        bind('ps-template-text', 'template', 'text');
        const bindList = (id, key) => {
            const el = div.querySelector('#' + id);
            if (!el) return;
            el.value = Array.isArray(s[key]) ? s[key].join(', ') : '';
            el.addEventListener('input', () => {
                s[key] = String(el.value || '').split(',').map((x) => x.trim()).filter(Boolean);
                saveSettings();
            });
        };
        const bindJson = (id, key) => {
            const el = div.querySelector('#' + id);
            if (!el) return;
            el.value = JSON.stringify(s[key] || {});
            el.addEventListener('input', () => {
                try {
                    const obj = JSON.parse(String(el.value || '{}'));
                    if (obj && typeof obj === 'object' && !Array.isArray(obj)) { s[key] = obj; saveSettings(); }
                } catch (e) { /* 输入中不合法就先不保存 */ }
            });
        };
        bindList('ps-books-text', 'appearanceBooks');
        bindJson('ps-aliases-text', 'aliases');
        bindAuto('ps-auto-maintain', 'autoMaintain');
        bindAuto('ps-auto-chat', 'autoOnChatChange');
        bindAuto('ps-auto-source', 'autoOnSourceChange');
        bindNum('ps-auto-n', 'autoEveryN', 0, 50);
        bindNum('ps-auto-check', 'autoCheckMs', 10, 600, 1000);
        bindNum('ps-auto-maxage', 'coreMaxAgeMs', 1, 720, 60000);
        bindNum('ps-auto-max', 'maxTagsPerChar', 5, 100);
        div.querySelector('#ps-rebuild').addEventListener('click', async () => {
            st().textContent = '正在重建（角色卡+人格+书+外观）…';
            try {
                const r = await rebuildCore({ mode: 'manual', forceBook: true });
                st().textContent = r.msg || '完成';
            } catch (e) { st().textContent = '重建失败：' + (e?.message || e); }
            updatePanelStatus();
        });
        div.querySelector('#ps-core-clear').addEventListener('click', () => {
            try {
                const st2 = store();
                st2.chars = {}; st2.bookChars = {}; st2.books = []; st2.booksFetchedAt = 0;
                st2.updatedAt = 0; st2.fingerprint = '';
                saveSettings(); mirrorCoreVariables(); updatePanelStatus();
                st().textContent = '核心表已清空（下次写词/切聊天会自动重建）';
            } catch (e) { st().textContent = '清空失败'; }
        });
        div.querySelector('#ps-core-copy').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(JSON.stringify(store(), null, 2));
                st().textContent = '核心表 JSON 已复制到剪贴板';
            } catch (e) { st().textContent = '复制失败（浏览器不允许剪贴板）'; }
        });
        div.querySelector('#ps-clearcache').addEventListener('click', () => {
            try { const c = ctx(); meta(c).cache = []; saveMeta(); st().textContent = '缓存已清空'; } catch (e) { st().textContent = '清空失败'; }
        });
        div.querySelector('#ps-collapse-now').addEventListener('click', () => { collapseReasoning(); st().textContent = '已折叠'; });
        updatePanelStatus();
        st().textContent = `变量：dsh_ps_scene / dsh_ps_cast / dsh_ps_camera / dsh_ps_last（聊天变量，可在世界书/人格里用 {{getvar::dsh_ps_scene}}）`;
    }

    // ---------------------------------------------------------------- 初始化
    async function init() {
        const c = await waitFor(() => ctx(), 300000, 300);
        if (!c) return;
        await waitFor(() => document.getElementById('extensions_settings2') || document.getElementById('extensions_settings'), 120000, 500);
        buildPanel();
        migrateLegacyCore();
        const safe = (ev, fn) => { try { c.eventSource.on(ev, fn); } catch (e) { /* ignore */ } };
        if (c.eventTypes) {
            safe(c.eventTypes.CHARACTER_MESSAGE_RENDERED, scheduleCollapse);
            safe(c.eventTypes.MESSAGE_RECEIVED, () => {
                scheduleCollapse();
                aiMsgCount++;
                const n = Number(S().autoEveryN) || 0;
                if (n > 0 && aiMsgCount % n === 0) scheduleAuto('everyN', 1500);
            });
            safe(c.eventTypes.CHAT_CHANGED, () => {
                aiMsgCount = 0;
                setTimeout(collapseReasoning, 800);
                scheduleAuto('chat', 1200);
                // 切聊天后外观扩展会异步同步角色档案，稍后再查两次指纹
                setTimeout(() => scheduleAuto('source', 1500), 6000);
                setTimeout(() => scheduleAuto('source', 1500), 15000);
            });
            safe(c.eventTypes.CHARACTER_EDITED, () => scheduleAuto('source', 1200));
            safe(c.eventTypes.PERSONA_CHANGED, () => scheduleAuto('source', 1200));
            safe(c.eventTypes.CHARACTER_RENAMED, () => scheduleAuto('source', 1200));
            safe(c.eventTypes.WORLDINFO_UPDATED, () => scheduleAuto('source', 1500, { bookDirty: true }));
            safe(c.eventTypes.GENERATION_ENDED, () => scheduleAuto('source', 2000));
        }
        startAutoTimer();
        window.__DSH_PROMPT_STABLE = {
            version: VERSION,
            settings: S,
            writePrompt,
            fallbackTags,
            renderTemplate,
            rebuildCore,
            ensureCoreForWrite,
            scheduleAuto,
            needsRefresh,
            currentFingerprint,
            coreStore: () => store(),
            coreTagsFor,
            collapseReasoning,
            mergeConsistency,
            parseAppearanceBlock,
            state: () => meta(ctx()).state,
            cache: () => meta(ctx()).cache,
            core: () => {
                const out = {};
                const st = store();
                for (const [n, e] of Object.entries(st.chars || {})) out[n] = (e?.tags || []).slice();
                return out;
            },
            clearCache: () => { const c2 = ctx(); meta(c2).cache = []; saveMeta(); },
        };
        updatePanelStatus();
        if (S().enabled && S().autoMaintain) {
            // 启动后分几次检查：外观档案是异步加载的，第一次可能比它早
            for (const ms of [3000, 10000, 25000]) setTimeout(() => scheduleAuto('startup', 200), ms);
        }
        console.log(`${LOG} v${VERSION} 已加载`);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init(), { once: true });
    else init();
})();

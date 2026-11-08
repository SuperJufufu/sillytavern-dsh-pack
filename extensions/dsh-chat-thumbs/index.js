/**
 * 聊天列表（封面 + 预览）(dsh-chat-thumbs) v1.3.0
 *
 * 问题：ST 的「欢迎页 Recent Chats」和「聊天记录管理」列表里，每条聊天左侧的小图
 *      用的是**角色卡头像**（同一个角色所有聊天一张图；旁白更是同一个图标），
 *      没法让每个聊天显示自己的图像。
 *
 * v1.3.0 列表整理（三件小事的合集）：
 *   ① 时间：把「2026/10/31」换成相对时间 —— 今天 04:30 / 昨天 04:30 / 10-30 / 2025/10/31
 *      （从 .chatDate 的 title 里解析原始时间，兼容中文「2026年10月31日 04:30」和英文「October 31, 2026 4:30am」）
 *   ② 标题：隐藏重复的「旁白 - 」角色名前缀，只显示聊天名；完整「角色 - 聊天」放进 tooltip
 *   ③ 展开：默认最多展开前 8 条（原来把有封面的全部展开，列表太长），其余保持折叠、可点「展开更多」
 *
 * 做法：本扩展在列表渲染后，把对应聊天的头像换成该聊天的场景插画
 *      （/user/images/auto-avatar/*.png，1216×832 横版，CSS cover 裁成方形小图）。
 *      没配置的聊天保持原样。
 *
 * v1.1.0 —— 改名不再丢封面（根因：map.json 的键带聊天文件名，chat-namer 自动改名后键失效）：
 *   1) map.json 仍是快路径：{ "角色卡头像文件名|聊天文件名": "图片URL" }
 *   2) 查不到时看「内容缓存」（localStorage）：头像|聊天文件名 → 场景图。
 *      当前打开的聊天里只要有【场景插画】消息（extra.backfill_scene / generationType==='scene'），
 *      就按当前 chatId 记一条 —— chat-namer 改名后 CHAT_CHANGED，缓存立刻用新名字记好，回欢迎页即生效。
 *   3) 缓存也没有（比如刷新页面/别处改名）：POST /api/chats/get 现场读聊天文件内容，找到那条插画消息。
 *      所以「封面」的唯一权威来源是聊天内容本身，改名字影响不到它。
 *
 * v1.2.0 —— 列表预览清洗（原来显示的是生图提示词 / 「【场景插画】」占位符）：
 *   ST 的预览取的是「最后一条消息的 mes」。聊天最后一条常是图片消息
 *   （mes = "[旁白 sends a picture that contains: 2girls, …提示词…]"）或我们贴的场景插画
 *   （mes = "【场景插画】"），于是列表里全是英文 tag 和占位符。现在：
 *   · 识别出这类「垃圾预览」（提示词 / 占位符 / [The message is empty] / 英文 tag 串），
 *   · 从聊天内容里往前找最后一条**真正的正文**，清洗 markdown/动作星号/重复说话人前缀，截 96 字，
 *     把预览换成「发言人：正文」（tooltip 放全文）；实在没有正文就显示「（暂无文字消息）」。
 *   · 和封面共用一次 /api/chats/get 读取（本会话缓存，不写盘，避免预览过期）。
 *
 * 面板可关；改完 map.json 在面板点「重新加载映射」即可（不用刷新页面）。
 * 删掉 extensions/dsh-chat-thumbs 即可移除。
 */
(function () {
    'use strict';

    const MODULE = 'dsh-chat-thumbs';
    const VERSION = '1.3.0';
    const MAP_URL = '/scripts/extensions/third-party/dsh-chat-thumbs/map.json';
    const COVER_CACHE_KEY = 'dsh-chat-thumbs:covers:v1';
    const MAX_FETCH_PER_PATCH = 10; // 欢迎页一次最多现场读几个聊天文件（封面/预览共用）
    const EXPAND_LIMIT = 8;         // 默认最多展开几条（其余交给「展开更多」按钮）

    const DEFAULTS = { enabled: true, loaded: 0, lastError: '' };

    let map = null;
    let mapTs = 0;
    let patching = false;
    let timer = null;

    const ctx = () => window.SillyTavern.getContext();

    function settings() {
        const c = ctx();
        if (!c.extensionSettings[MODULE] || typeof c.extensionSettings[MODULE] !== 'object') c.extensionSettings[MODULE] = {};
        const s = c.extensionSettings[MODULE];
        for (const k of Object.keys(DEFAULTS)) if (s[k] === undefined) s[k] = DEFAULTS[k];
        return s;
    }
    function save() { try { ctx().saveSettingsDebounced?.(); } catch (e) { /* ignore */ } }
    function status(text) {
        const el = document.getElementById('ct-status');
        if (el) el.textContent = text;
        console.log('[chat-thumbs] ' + text);
    }

    function injectCss() {
        if (document.getElementById('ct-style')) return;
        const st = document.createElement('style');
        st.id = 'ct-style';
        st.textContent = `
            .welcomePanel .recentChatList .recentChat.dsh-chat-thumb .avatar {
                width: 46px !important; height: 46px !important; flex: 0 0 46px !important;
                overflow: hidden !important; border-radius: 8px !important;
            }
            .welcomePanel .recentChatList .recentChat.dsh-chat-thumb .avatar img {
                width: 46px !important; height: 46px !important; max-width: none !important;
                object-fit: cover !important; object-position: center 35% !important;
                display: block !important; border-radius: 8px !important;
            }
            #select_chat_div .select_chat_block.dsh-chat-thumb .avatar img {
                object-fit: cover !important; object-position: center 35% !important;
            }
            /* v1.2.0：清洗后的预览压成一行（齐全行高，悬停看全文） */
            .welcomePanel .recentChatList .recentChat.dsh-chat-preview .chatMessage {
                display: block !important;
                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                -webkit-line-clamp: unset !important;
                line-clamp: unset !important;
                opacity: .85;
            }
            /* v1.3.0：标题只显示聊天名（隐藏「旁白 - 」这类重复角色名前缀；完整名在 tooltip） */
            .welcomePanel .recentChatList .recentChat.dsh-chat-title .chatName > strong.characterName,
            .welcomePanel .recentChatList .recentChat.dsh-chat-title .chatName > span:not(:last-child) {
                display: none !important;
            }
            .welcomePanel .recentChatList .recentChat .chatDate {
                white-space: nowrap !important;
            }
        `;
        document.head.appendChild(st);
    }

    async function loadMap(force) {
        const now = Date.now();
        if (!force && map && now - mapTs < 60000) return map;
        try {
            const r = await fetch(MAP_URL + '?t=' + now, { cache: 'no-store' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            map = {};
            // 两种键都存：带 .jsonl 和不带（欢迎页 data-file 不带扩展名，聊天记录弹窗带）
            for (const [k, v] of Object.entries(j && typeof j === 'object' ? j : {})) {
                map[k] = v;
                map[String(k).replace(/\.jsonl$/, '')] = v;
            }
            mapTs = now;
            settings().loaded = Object.keys(map).length;
            settings().lastError = '';
            save();
        } catch (e) {
            map = map || {};
            settings().lastError = String(e.message || e).slice(0, 200);
            save();
        }
        return map;
    }

    function lookup(m, avatar, file) {
        if (!m) return '';
        const keys = [
            avatar + '|' + file,
            avatar + '|' + String(file).replace(/\.jsonl$/, ''),
            String(file),
        ];
        for (const k of keys) {
            if (m[k]) return typeof m[k] === 'string' ? m[k] : (m[k].image || '');
        }
        return '';
    }

    // ---------------------------------------------------- 改名自愈：内容缓存 --
    // map.json 的键带聊天文件名，聊天一改名就查不到。场景图的**唯一权威来源是聊天内容**
    // （那条 extra.backfill_scene 的【场景插画】消息），所以这里按内容缓存，并支持现场读聊天文件。
    let coverCache = readCoverCache();
    const inflight = new Map();

    function readCoverCache() {
        try {
            const j = JSON.parse(localStorage.getItem(COVER_CACHE_KEY) || '{}');
            return j && typeof j === 'object' ? j : {};
        } catch (e) { return {}; }
    }
    function saveCoverCache() {
        try {
            const keys = Object.keys(coverCache);
            if (keys.length > 400) {
                keys.sort((a, b) => (Number(coverCache[b] && coverCache[b].ts) || 0) - (Number(coverCache[a] && coverCache[a].ts) || 0));
                for (const k of keys.slice(400)) delete coverCache[k];
            }
            localStorage.setItem(COVER_CACHE_KEY, JSON.stringify(coverCache));
        } catch (e) { /* ignore */ }
    }
    function cacheKey(avatar, file) {
        return avatar + '|' + String(file).replace(/\.jsonl$/, '');
    }
    function cacheSet(avatar, file, url) {
        if (!avatar) return;
        const k = cacheKey(avatar, file);
        if (coverCache[k] && coverCache[k].url === url) return;
        coverCache[k] = { url: String(url || ''), ts: Date.now() };
        saveCoverCache();
    }

    /** 从消息数组里找最后一条【场景插画】消息的图（聊天文件里的权威来源） */
    function sceneImageFromMessages(msgs) {
        let img = '';
        for (const m of msgs || []) {
            const ex = (m && m.extra) || {};
            if (ex.backfill_scene || ex.generationType === 'scene') {
                const v = String(ex.image || '');
                if (v) img = v;
            }
        }
        return img;
    }

    /** 判断一段预览文字是不是「没用」的（生图提示词 / 占位符 / 空） */
    function isJunkPreview(text) {
        const t = String(text || '').trim();
        if (!t) return true;
        if (t.includes('【场景插画】')) return true;
        if (/^\[?\s*The (chat|message) is empty\s*\]?$/i.test(t)) return true;
        if (/sends a picture that contains/i.test(t)) return true;
        if (/^\[[^\]]{0,60}\]$/.test(t)) return true; // [xxx sends a picture…] 之类
        // 英文 tag 串（SD 写词结果）：大多 ASCII + 逗号很多 / 一上来就是人数标签
        const ascii = (t.match(/[\x00-\x7F]/g) || []).length;
        if (ascii / Math.max(1, t.length) > 0.85 && t.split(',').length >= 3) return true;
        if (/^(?:1girl|1boy|2girls|3girls|solo|multiple girls|masterpiece|best quality)\b/i.test(t)) return true;
        return false;
    }

    /** 正文清洗：去掉 markdown / 动作星号 / 重复的说话人前缀，压成一行 */
    function cleanPreviewText(raw, name) {
        let t = String(raw || '');
        t = t.replace(/```[\s\S]*?```/g, ' ').replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
        // 去掉重复的「旁白: 旁白: 」这类前缀（最多 3 次）
        for (let i = 0; i < 3; i++) {
            const m = t.match(/^\s*([^\s:：]{1,12})\s*[:：]\s*/);
            if (!m) break;
            const who = m[1];
            const isSpeaker = (name && who === name) || /^(旁白|narrator|系统|system|user|assistant)$/i.test(who);
            if (!isSpeaker) break;
            t = t.slice(m[0].length);
        }
        t = t.replace(/\*\*?/g, ' ').replace(/\s+/g, ' ').trim();
        t = t.replace(/^[\s,，、;；:：.。!！?？"'“”‘’()（）\-—]+/, '').trim();
        return t;
    }

    /** 预览：从最后一条往前找「真正的正文」，跳过图片提示词/占位符；带发言人前缀 */
    function previewFromMessages(msgs) {
        for (let i = (msgs || []).length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (!m || m.is_system) continue;
            const raw = String(m.mes || '');
            if (!raw.trim()) continue;
            if (isJunkPreview(raw)) continue;
            const t = cleanPreviewText(raw, String(m.name || ''));
            if (!t || t.length < 2) continue; // 只有一个标点/符号的也算没内容
            const speaker = String(m.name || '').trim();
            const full = (speaker ? speaker + '：' : '') + t;
            return { text: full.length > 96 ? full.slice(0, 94) + '…' : full, full, speaker };
        }
        return null;
    }

    // ------------------------------------------------ 相对时间（v1.3.0） --
    const MONTH_FULL = {
        january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
        july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    };
    const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

    /** 解析 .chatDate 的 title / 文本里的时间 → { d, hasTime } | null */
    function parseTimestampText(text) {
        const t = String(text || '').trim();
        if (!t) return null;
        let m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(上午|下午|凌晨|早上|晚上|中午)?\s*(\d{1,2})[:：](\d{2})/);
        if (m) {
            let h = Number(m[5]);
            const ap = m[4] || '';
            if ((ap === '下午' || ap === '晚上') && h < 12) h += 12;
            if ((ap === '凌晨' || ap === '早上' || ap === '上午') && h === 12) h = 0;
            return { d: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, Number(m[6])), hasTime: true };
        }
        m = t.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
        if (m) {
            const mon = MONTH_FULL[m[1].toLowerCase()] || MONTH_ABBR[m[1].toLowerCase().slice(0, 3)];
            if (mon) {
                let h = Number(m[4]);
                const ap = (m[6] || '').toLowerCase();
                if (ap === 'pm' && h < 12) h += 12;
                if (ap === 'am' && h === 12) h = 0;
                return { d: new Date(Number(m[3]), mon - 1, Number(m[2]), h, Number(m[5])), hasTime: true };
            }
        }
        // 只有日期：YYYY/M/D、YYYY-M-D、YYYY年M月D日
        m = t.match(/(\d{4})\s*[年\/\-.]\s*(\d{1,2})\s*[月\/\-.]\s*(\d{1,2})/);
        if (m) return { d: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0), hasTime: false };
        return null;
    }

    /** 今天 04:30 / 昨天 04:30 / 10-30 / 2025/10/31 */
    function formatRelativeTime(parsed) {
        if (!parsed || !parsed.d || isNaN(parsed.d.getTime())) return '';
        const d = parsed.d;
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const diff = Math.round((today - that) / 86400000);
        const hm = parsed.hasTime ? (' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')) : '';
        if (diff === 0) return '今天' + hm;
        if (diff === 1) return '昨天' + hm;
        if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '-' + d.getDate() + hm;
        return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
    }

    /** 标题去重：隐藏「旁白 - 」角色名前缀，只留聊天名；tooltip 保留完整的「角色 - 聊天」 */
    function patchRowTitle(el) {
        const chatNameEl = el.querySelector('.chatName');
        const nameEl = el.querySelector('.characterName');
        if (!chatNameEl) return;
        const char = nameEl ? String(nameEl.textContent || '').trim() : '';
        const spans = chatNameEl.querySelectorAll('span');
        const chat = spans.length ? String(spans[spans.length - 1].textContent || '').trim() : '';
        const full = char && chat ? char + ' - ' + chat : (chat || char);
        if (full && chatNameEl.getAttribute('title') !== full) chatNameEl.setAttribute('title', full);
        el.classList.add('dsh-chat-title');
    }

    /** 时间改成相对时间（title/text 都解析不了就保持原样） */
    function patchRowDate(el) {
        const dateEl = el.querySelector('.chatDate');
        if (!dateEl) return;
        const parsed = parseTimestampText(dateEl.getAttribute('title')) || parseTimestampText(dateEl.textContent);
        if (!parsed) return;
        const rel = formatRelativeTime(parsed);
        if (!rel) return;
        if (dateEl.textContent !== rel) {
            dateEl.textContent = rel;
            dateEl.setAttribute('data-ct-date', '1');
        }
    }

    /**
     * 现场读聊天文件（/api/chats/get 返回第一行 header + 每条消息，含 extra）。
     * 一次返回两样东西：场景封面图 + 最后一条正文预览（都从聊天内容里来，改名影响不到）。
     */
    async function fetchChatData(avatar, file) {
        const empty = { url: '', preview: null };
        try {
            const c = ctx();
            const r = await fetch('/api/chats/get', {
                method: 'POST',
                headers: c.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, file_name: String(file).replace(/\.jsonl$/, '') }),
                cache: 'no-cache',
            });
            if (!r.ok) return empty;
            const arr = await r.json();
            if (!Array.isArray(arr)) return empty;
            const msgs = arr.filter((m) => m && (m.mes !== undefined || (m.extra && m.extra.image)));
            return { url: sceneImageFromMessages(msgs), preview: previewFromMessages(msgs) };
        } catch (e) {
            console.warn('[chat-thumbs] 读取聊天内容失败:', (e && e.message) || e);
            return empty;
        }
    }

    // 聊天内容缓存（本次页面会话内，不写盘：预览会随聊天变化，写盘容易过期）
    const chatDataCache = new Map(); // avatar|file -> { url, preview }

    async function getChatData(avatar, file, budget) {
        const k = cacheKey(avatar, file);
        const hit = chatDataCache.get(k);
        if (hit) return hit;
        if (!avatar || !budget || budget.n >= MAX_FETCH_PER_PATCH) return null;
        budget.n++;
        if (inflight.has(k)) return inflight.get(k);
        const p = fetchChatData(avatar, file).then((d) => {
            chatDataCache.set(k, d);
            if (d && d.url) cacheSet(avatar, file, d.url);
            inflight.delete(k);
            return d;
        }).catch(() => { inflight.delete(k); return null; });
        inflight.set(k, p);
        return p;
    }

    function cachedCover(avatar, file) {
        const k = cacheKey(avatar, file);
        return coverCache[k] ? String(coverCache[k].url || '') : '';
    }

    /**
     * 当前打开的聊天：把「场景图 + 预览」按当前 chatId 记进内存缓存。
     * chat-namer 改名时 ST 会 reloadCurrentChat（CHAT_CHANGED），这里立刻用新名字记好。
     */
    function cacheFromCurrentChat() {
        try {
            const c = ctx();
            const chatId = String(c.chatId || '');
            if (!chatId) return '';
            const ch = (c.characters || [])[Number(c.characterId)];
            const avatar = ch ? String(ch.avatar || '') : '';
            if (!avatar) return '';
            const msgs = c.chat || [];
            const img = sceneImageFromMessages(msgs);
            const preview = previewFromMessages(msgs);
            chatDataCache.set(cacheKey(avatar, chatId), { url: img, preview });
            if (img) cacheSet(avatar, chatId, img);
            return img;
        } catch (e) { return ''; }
    }

    /** 当前聊天有新消息 → 缓存里的预览作废（下次回欢迎页重新读最新内容） */
    function invalidateCurrentChatData() {
        try {
            const c = ctx();
            const chatId = String(c.chatId || '');
            const ch = (c.characters || [])[Number(c.characterId)];
            const avatar = ch ? String(ch.avatar || '') : '';
            if (avatar && chatId) chatDataCache.delete(cacheKey(avatar, chatId));
        } catch (e) { /* ignore */ }
    }

    function stamp() {
        // 只是让浏览器重新取图（文件内容可能被重画过）
        return '?v=' + Math.floor(Date.now() / 1000);
    }

    async function patchWelcome(m) {
        injectCss();
        const rows = document.querySelectorAll('.recentChat');
        let thumbs = 0;
        let previews = 0;
        let shown = 0;
        const budget = { n: 0 };
        for (const el of rows) {
            const avatar = el.getAttribute('data-avatar') || '';
            const file = el.getAttribute('data-file') || '';
            const img = el.querySelector('.avatar img');
            if (!img) continue;
            patchRowTitle(el);   // 标题：隐藏「旁白 - 」前缀
            patchRowDate(el);    // 时间：今天/昨天/10-30
            const msgEl = el.querySelector('.chatMessage');
            // 预览总是从聊天内容重建（统一带「发言人：」前缀；ST 原始预览常是提示词/占位符）
            const needPreview = !!msgEl;
            let url = lookup(m, avatar, file) || cachedCover(avatar, file);
            let data = null;
            if (!url || needPreview) {
                data = await getChatData(avatar, file, budget);
                if (!url && data && data.url) url = data.url;
            }
            if (url) {
                if (img.getAttribute('data-ct-src') !== url) {
                    img.setAttribute('data-ct-src', url);
                    img.setAttribute('src', url + stamp());
                    img.setAttribute('title', '场景插画：' + String(file).replace(/\.jsonl$/, ''));
                    el.classList.add('dsh-chat-thumb');
                    thumbs++;
                }
                // 默认只展开前 EXPAND_LIMIT 条（其余保持折叠，「展开更多」仍可点）
                if (shown < EXPAND_LIMIT) {
                    el.classList.remove('hidden');
                    shown++;
                }
            }
            if (needPreview) {
                if (data && data.preview) {
                    if (msgEl.textContent !== data.preview.text) {
                        msgEl.textContent = data.preview.text;
                        msgEl.setAttribute('title', data.preview.full);
                        el.classList.add('dsh-chat-preview');
                        previews++;
                    }
                } else if (data) {
                    const fallback = '（暂无文字消息）';
                    if (msgEl.textContent !== fallback) {
                        msgEl.textContent = fallback;
                        el.classList.add('dsh-chat-preview');
                        previews++;
                    }
                }
            }
        }
        return { thumbs, previews };
    }

    async function patchChatHistory(m) {
        const div = document.getElementById('select_chat_div');
        if (!div) return 0;
        const c = ctx();
        const ch = (c.characters || [])[Number(c.characterId)];
        const avatar = ch ? String(ch.avatar || '') : '';
        let n = 0;
        const budget = { n: 0 };
        for (const el of div.querySelectorAll('.select_chat_block')) {
            const file = el.getAttribute('file_name') || '';
            const img = el.querySelector('.avatar img');
            if (!img) continue;
            let url = lookup(m, avatar, file) || cachedCover(avatar, file);
            if (!url) {
                const data = await getChatData(avatar, file, budget);
                url = (data && data.url) || '';
            }
            if (!url) continue;
            if (img.getAttribute('data-ct-src') === url) continue;
            img.setAttribute('data-ct-src', url);
            img.setAttribute('src', url + stamp());
            el.classList.add('dsh-chat-thumb');
            n++;
        }
        return n;
    }

    async function patchAll(reason) {
        if (patching) return;
        patching = true;
        try {
            if (!settings().enabled) return;
            cacheFromCurrentChat(); // 打开着的聊天（含刚被 chat-namer 改名的）先按当前名字记一条缓存
            const m = await loadMap(false);
            const a = await patchWelcome(m);
            const b = await patchChatHistory(m);
            const bits = [];
            if (a.thumbs) bits.push('封面 ' + a.thumbs + ' 行');
            if (a.previews) bits.push('预览清洗 ' + a.previews + ' 条');
            if (b) bits.push('聊天记录弹窗 ' + b + ' 行');
            if (bits.length) status('已套用：' + bits.join('，'));
        } catch (e) {
            console.warn('[chat-thumbs]', e);
        } finally {
            patching = false;
        }
    }

    function schedule(reason) {
        clearTimeout(timer);
        timer = setTimeout(() => patchAll(reason), 150);
    }

    function startObserver() {
        const obs = new MutationObserver((muts) => {
            for (const mu of muts) {
                if (mu.addedNodes && mu.addedNodes.length) { schedule('mutation'); return; }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    function buildPanel() {
        if (document.getElementById('ct-panel')) return;
        const host = document.getElementById('extensions_settings');
        if (!host) return;
        const s = settings();
        const div = document.createElement('div');
        div.id = 'ct-panel';
        div.className = 'extension_container';
        div.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>聊天列表头像（场景插画）</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="ct-enabled" ${s.enabled ? 'checked' : ''}>
                        <span>在「Recent Chats / 聊天记录」列表里，用对应聊天的场景插画替代角色卡头像；预览里的生图提示词 / 「【场景插画】」占位会换成最后一条正文</span>
                    </label>
                    <div class="flex-container flexGap5" style="flex-wrap:wrap;">
                        <div id="ct-reload" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">重新加载映射</div>
                        <span id="ct-status" style="font-size:12px;opacity:.75;flex:1 1 100px;min-width:0;line-height:1.4;"></span>
                    </div>
                    <div id="ct-last" style="font-size:11px;opacity:.6;margin-top:6px;"></div>
                    <small style="opacity:.6;display:block;margin-top:6px;">
                        映射文件：extensions/dsh-chat-thumbs/map.json（角色卡头像文件名|聊天文件名 → 图片地址）。
                        没配的聊天保持原头像。<br>
                        v1.1.0：聊天被改名后，会自动从聊天内容里那条【场景插画】消息找回封面（先查本地缓存，再现场读聊天文件）。<br>
                        v1.2.0：列表预览不再显示生图提示词 / 占位符，改成「发言人：最后一条正文」（截 96 字，悬停看全文）。<br>
                        v1.3.0：时间改成「今天 04:30 / 昨天 / 10-30」；标题只显示聊天名（角色名前缀藏在 tooltip）；默认最多展开 8 条。
                    </small>
                </div>
            </div>`;
        host.appendChild(div);
        div.querySelector('#ct-enabled').addEventListener('change', (e) => {
            settings().enabled = e.target.checked; save();
            status(e.target.checked ? '已开启' : '已关闭');
            if (e.target.checked) { map = null; schedule('enable'); }
        });
        div.querySelector('#ct-reload').addEventListener('click', async () => { map = null; await loadMap(true); schedule('reload'); });
        status('已加载映射 ' + s.loaded + ' 条' + (s.lastError ? '｜错误：' + s.lastError : ''));
        const last = document.getElementById('ct-last');
        if (last) last.textContent = '映射条数：' + s.loaded;
    }

    jQuery(async () => {
        await new Promise((r) => setTimeout(r, 2500));
        try {
            const c = ctx();
            await loadMap(true);
            buildPanel();
            startObserver();
            cacheFromCurrentChat();
            schedule('startup');
            // 切聊天/改名后：ST 会 reloadCurrentChat，这时缓存里用新 chatId 记好场景图
            // 切聊天/改名后：ST 会 reloadCurrentChat，这时缓存里用新 chatId 记好场景图 + 预览
            c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
                cacheFromCurrentChat();
                setTimeout(() => cacheFromCurrentChat(), 1200); // 等消息渲染完再补一次
                schedule('chat-changed');
            });
            // 当前聊天有新消息 → 预览缓存作废（回欢迎页时重新读）
            try { c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, invalidateCurrentChatData); } catch (e) { /* ignore */ }
            try { c.eventSource.on(c.eventTypes.MESSAGE_SENT, invalidateCurrentChatData); } catch (e) { /* ignore */ }
            setTimeout(() => schedule('later'), 1500);
            console.log('[chat-thumbs] v' + VERSION + ' 已加载，映射 ' + settings().loaded + ' 条（改名自愈 + 预览清洗）');
        } catch (e) {
            console.error('[chat-thumbs] 初始化失败', e);
        }
    });

    window.__DSH_CHAT_THUMBS = {
        version: VERSION,
        map: () => map,
        covers: () => coverCache,
        chatData: () => chatDataCache,
        cacheChat: () => cacheFromCurrentChat(),
        reload: async () => { map = null; await loadMap(true); return Object.keys(map || {}).length; },
        patch: () => patchAll('manual'),
    };
})();

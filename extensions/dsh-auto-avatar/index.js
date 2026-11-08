/**
 * 自动画头像 (dsh-auto-avatar) v1.0.1
 *
 * 作用：
 *   1. 每个「新会话第一轮」（用户第一次说话 + AI 第一次回复）之后，自动给
 *      **正文里最先出现的角色**画一张头像，并直接替换该角色卡的头像
 *      （characters/<名字>.png）；原图会先备份。
 *      没有角色卡可换时，退回当前聊天角色卡。
 *   2. 可选：顺带给当前 persona 画一张头像（面板开关，默认关；只画一次）。
 *      头像文件用 ST 里当前 persona 自己的头像名，不写死任何文件名。
 *
 * 出图链路（和 /imagine 一样，必须走桥接，别直连 ComfyUI）：
 *   SDXL-Illustrious 工作流 → /api/sd/comfy/generate（桥接地址见文件顶部常量）→ ComfyUI
 *   dsh-gpu-queue 会把请求排进单通道，不会和其它出图抢显卡。
 *
 * 头像提示词来源（按优先级）：
 *   ① 面板里配置的世界书里，该角色条目的【SD标签】
 *   ② 角色卡里已有的【SD标签】
 *   ③ 都没有 → 用 ST 主模型（generateRaw）临时从卡面外貌生成一组标签
 *   未配置世界书时自动只用角色卡描述（通用回退）。
 *
 * 安全：
 *   · 只改头像图片，角色卡的文字内容通过 json_data + 全字段原样回写
 *   · 换之前把旧头像存进 user/files/avatar-backup-*.png（可用 /user/files/<名字> 下载）
 *   · 每个聊天只画一次（chat_metadata.__dsh_auto_avatar），失败也不会无限重试
 *
 * 删掉 extensions/dsh-auto-avatar 即可移除。
 */
(function () {
    'use strict';

    const MODULE = 'dsh-auto-avatar';
    const MARK = '__dsh_auto_avatar';
    const VERSION = '1.0.1';

    // ---------------------------------------------------------------- 部署地址 --
    // ComfyUI 桥接：ST 的 /api/sd/comfy/* 把出图请求转发到这里（默认本机 8189）。
    // 优先用 ST 生图扩展设置里的 sd.comfy_url，没有才用这个默认值。
    const DEFAULT_COMFY_URL = 'http://127.0.0.1:8189';

    const DEFAULTS = {
        enabled: true,
        drawOnFirstRound: true,     // 新会话第一轮自动画第一个出现的角色
        drawPersona: false,         // 可选：顺带给当前 persona 画头像（只画一次，默认关）
        personaDone: false,
        workflow: 'SDXL-Illustrious.json',
        width: 832,
        height: 1216,
        promptExtra: '',
        // 世界书来源：书名数组。空 = 只用角色卡描述（通用回退）。
        lorebooks: [],
        // 可选：世界书条目里的「对话隔离」标记（如某个书用「标记 + chatId」区分聊天）。
        // 空 = 不做聊天隔离；只有配置了标记的书才按聊天过滤。
        chatScopeTag: '',
        // 画头像时跳过的「非角色」名字（内置 narrator/assistant/system/npc，
        // 这里可以追加，逗号分隔；留空 = 只用内置列表）。
        skipNames: '',
        lastTarget: '',
        lastAt: 0,
        lastError: '',
        personaAt: 0,
    };

    function listSetting(value) {
        const raw = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
        return raw.map((x) => String(x).trim()).filter(Boolean);
    }

    function lorebookNames() {
        return listSetting(settings().lorebooks);
    }

    // 内置的「不是可画角色」的名字；用户可用 skipNames 追加。
    const NON_CHARACTER_NAMES = /^(narrator|assistant|system|npc)$/i;

    function isNonCharacterName(name) {
        const n = String(name || '').trim();
        if (!n) return true;
        if (NON_CHARACTER_NAMES.test(n)) return true;
        return listSetting(settings().skipNames).some((x) => x.toLowerCase() === n.toLowerCase());
    }

    // 头像标签清理：去掉和固定构图重复的标签、画质标签，避免同一概念重复堆叠。
    // 公开版不内置任何成人向词表；标签内容由世界书 / 角色卡 / 主模型决定。
    const BAD_TAG_RE = /(solo|1girl|2girls|3girls|multiple girls|portrait|head and shoulders|upper body|looking at viewer|centered composition|simple background|gradient background|best quality|masterpiece|amazing quality|absurdres|highres|pov)/i;

    // 角色卡头像用「头肩特写」，persona 用上半身；构图/画质标签由扩展自己加。
    const STYLE_FRAMING_CHARACTER = '1girl, solo, portrait, head and shoulders, face focus, looking at viewer, centered composition, simple background, gradient background, soft lighting, clothed, masterpiece, best quality, amazing quality, absurdres';
    const STYLE_FRAMING_PERSONA = '1girl, solo, portrait, upper body, face focus, looking at viewer, centered composition, simple background, gradient background, soft lighting, clothed, masterpiece, best quality, amazing quality, absurdres';
    // 角色标签里没写衣服时补一件，避免头像缺少衣物（列表里展示用）
    const DEFAULT_CLOTHING_TAGS = 'white shirt, collarbone';
    const CLOTHING_RE = /(dress|shirt|robe|armor|armour|uniform|outfit|coat|jacket|cloak|suit|skirt|pants|shorts|kimono|swimsuit|leotard|camisole|tank top|sweater|hoodie|apron|vest|corset|bodysuit|stockings|boots|shoes)/i;
    // 只保留纯质量 / 解剖类 negative；不含任何成人向词。
    const NEG_HARD = 'lowres, bad anatomy, bad hands, extra fingers, text, error, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, multiple views, comic panel, split screen, thick lips, full lips, plump lips, lipstick, child, underage, photorealistic';

    let busy = false;
    let pending = false;
    let lastRun = null;

    const ctx = () => window.SillyTavern.getContext();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function settings() {
        const c = ctx();
        if (!c.extensionSettings[MODULE] || typeof c.extensionSettings[MODULE] !== 'object') {
            c.extensionSettings[MODULE] = {};
        }
        const s = c.extensionSettings[MODULE];
        for (const k of Object.keys(DEFAULTS)) {
            if (s[k] === undefined) s[k] = DEFAULTS[k];
        }
        return s;
    }
    function save() { try { ctx().saveSettingsDebounced?.(); } catch (e) { /* ignore */ } }
    function setMeta(patch) {
        try {
            const md = ctx().chatMetadata;
            if (!md) return;
            md[MARK] = Object.assign({}, md[MARK] || {}, patch || {});
            ctx().saveMetadata?.();
        } catch (e) { /* ignore */ }
    }
    function meta() { try { return (ctx().chatMetadata || {})[MARK] || null; } catch (e) { return null; } }

    function status(text) {
        try {
            const el = document.getElementById('aa-status');
            if (el) el.textContent = text;
            console.log('[auto-avatar] ' + text);
        } catch (e) { /* ignore */ }
    }
    function refreshLast() {
        const s = settings();
        const el = document.getElementById('aa-last');
        if (!el) return;
        const at = s.lastAt ? new Date(s.lastAt).toLocaleString() : '';
        el.textContent = '上次头像：' + (s.lastTarget || '(无)') + (at ? '（' + at + '）' : '') +
            (s.lastError ? '｜上次错误：' + String(s.lastError).slice(0, 120) : '');
    }

    // ------------------------------------------------------------- 提示词 ----
    function sanitizeTags(raw) {
        const list = String(raw || '').split(',').map((t) => t.trim()).filter(Boolean);
        const out = [];
        for (const t of list) {
            if (BAD_TAG_RE.test(t)) continue;
            const low = t.toLowerCase();
            if (out.some((x) => x.toLowerCase() === low)) continue;
            out.push(t);
        }
        return out.slice(0, 40);
    }

    function extractSdTags(text) {
        const m = String(text || '').match(/(?:【\s*SD\s*标签\s*】|[\[［]\s*sd_?tags?\s*[\]］])\s*[:：]?\s*([^\n]+)/i);
        return m ? String(m[1] || '').trim() : '';
    }

    async function loreEntries(book) {
        const TH = window.TavernHelper;
        if (!TH || typeof TH.getLorebookEntries !== 'function') return [];
        try { return (await TH.getLorebookEntries(book)) || []; } catch (e) { return []; }
    }

    function isEntryFor(entry, name) {
        const title = String(entry.comment || '');
        if (title === name || title === '角色：' + name || title === '角色:' + name) return true;
        const keys = [].concat(entry.keys || entry.key || []);
        return keys.some((k) => String(k).trim() === name);
    }

    /**
     * 该角色能拿到的所有设定文本（配置的世界书 > 角色卡描述）。
     * 没配置世界书时只用角色卡描述 —— 通用回退，不依赖任何特定书名。
     */
    async function collectSources(name) {
        const out = [];
        const chatId = String(ctx().chatId || '');
        const scopeTag = String(settings().chatScopeTag || '').trim();
        for (const book of lorebookNames()) {
            const entries = await loreEntries(book);
            for (const e of entries) {
                if (e && e.enabled === false) continue;
                if (!e || !isEntryFor(e, name)) continue;
                const content = String(e.content || '');
                if (!content) continue;
                // 可选：书里若用「标记 + chatId」区分聊天，配置标记后跳过别的聊天的条目
                if (scopeTag && chatId && content.includes(scopeTag) && !content.includes(scopeTag + chatId)) continue;
                out.push({ from: book, content });
            }
        }
        const ch = (ctx().characters || []).find((x) => String(x.name || '').trim() === name);
        if (ch) {
            const d = ch.data || {};
            const desc = String(d.description !== undefined ? d.description : (ch.description || ''));
            const pers = String(d.personality !== undefined ? d.personality : (ch.personality || ''));
            if (desc) out.push({ from: 'card', content: desc });
            if (pers) out.push({ from: 'card', content: pers });
        }
        return out;
    }

    async function tagsFor(name) {
        const srcs = await collectSources(name);
        for (const s of srcs) {
            const t = extractSdTags(s.content);
            if (t) {
                const clean = sanitizeTags(t);
                if (clean.length) return { tags: clean.join(', '), from: s.from };
            }
        }
        // 没有现成标签 → 让 DeepSeek 从外貌描述生成
        try {
            const text = srcs.map((s) => s.content).join('\n').slice(0, 2200);
            if (text) {
                const prompt = [
                    '你是 danbooru 标签生成器。根据下面的角色外貌设定，输出一行英文小写 danbooru 标签，逗号分隔，20-32 个。',
                    '必须包含：发色、发型、瞳色、肤色、体型、惯常服装、种族特征（兽耳/角/尾等）。',
                    '不要写 lips/lipstick/厚嘴唇；不要写姿势、人数、画质标签；只写与外貌和服装有关的标签。',
                    '只输出标签行，不要解释。',
                    '',
                    text,
                ].join('\n');
                const gen = await ctx().generateRaw({ prompt, responseLength: 120 });
                const line = String(gen || '').split('\n').map((x) => x.trim()).filter(Boolean).pop() || '';
                const clean = sanitizeTags(line.replace(/[。.]$/, ''));
                if (clean.length >= 5) return { tags: clean.join(', '), from: 'llm' };
            }
        } catch (e) {
            console.warn('[auto-avatar] 生成标签失败', e);
        }
        return { tags: '', from: 'none' };
    }

    function buildPrompt(tags, kind) {
        const extra = String(settings().promptExtra || '').trim();
        const framing = kind === 'persona' ? STYLE_FRAMING_PERSONA : STYLE_FRAMING_CHARACTER;
        const clothing = kind === 'character' && !CLOTHING_RE.test(tags) ? DEFAULT_CLOTHING_TAGS : '';
        return [framing, clothing, tags, extra].filter(Boolean).join(', ');
    }

    function buildNegative() {
        const sd = (ctx().extensionSettings && ctx().extensionSettings.sd) || {};
        const soft = String(sd.negative_prompt || '').trim();
        const all = [soft, NEG_HARD].filter(Boolean).join(', ').split(',').map((x) => x.trim()).filter(Boolean);
        const seen = new Set();
        const out = [];
        for (const t of all) {
            const k = t.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(t);
        }
        return out.join(', ');
    }

    // ------------------------------------------------------------- 出图 ------
    async function generatePortrait(prompt, negative) {
        const c = ctx();
        const sd = (c.extensionSettings && c.extensionSettings.sd) || {};
        const s = settings();
        const headers = c.getRequestHeaders();
        const wfResp = await fetch('/api/sd/comfy/workflow', {
            method: 'POST',
            headers,
            body: JSON.stringify({ file_name: s.workflow || sd.comfy_workflow || 'SDXL-Illustrious.json' }),
        });
        if (!wfResp.ok) throw new Error('读取出图工作流失败: ' + (await wfResp.text()).slice(0, 200));
        // 注意：/api/sd/comfy/workflow 返回的是「JSON 字符串」（文件内容被再编码了一层），
        // 必须用 .json() 解析；用 .text() 会拿到带引号的整体，再 JSON.parse 会得到字符串，
        // 发给 ComfyUI 就会报 AttributeError: 'str' object has no attribute 'items'。
        const rawWf = await wfResp.json();
        let wf = typeof rawWf === 'string' ? rawWf : JSON.stringify(rawWf);
        const seed = Math.floor(Math.random() * 2 ** 31);
        const num = (v, d) => JSON.stringify(Number(v) || d);
        wf = wf
            .replaceAll('"%prompt%"', JSON.stringify(prompt))
            .replaceAll('"%negative_prompt%"', JSON.stringify(negative))
            .replaceAll('"%seed%"', JSON.stringify(seed))
            .replaceAll('"%steps%"', num(sd.steps, 28))
            .replaceAll('"%scale%"', JSON.stringify(Number(sd.scale) || 5.5))
            .replaceAll('"%width%"', num(settings().width, 832))
            .replaceAll('"%height%"', num(settings().height, 1216))
            .replaceAll('"%denoise%"', JSON.stringify(1))
            .replaceAll('"%clip_skip%"', JSON.stringify(Number(sd.clip_skip) || 1))
            .replaceAll('"%model%"', JSON.stringify(sd.model || ''))
            .replaceAll('"%vae%"', JSON.stringify(sd.vae || ''))
            .replaceAll('"%sampler%"', JSON.stringify(sd.sampler || 'dpmpp_2m'))
            .replaceAll('"%scheduler%"', JSON.stringify(sd.scheduler || 'karras'));
        let graph;
        try {
            graph = JSON.parse(wf);
            // 双保险：万一还是被包了一层字符串
            if (typeof graph === 'string') graph = JSON.parse(graph);
        } catch (e) { throw new Error('出图工作流 JSON 解析失败: ' + e.message); }
        if (!graph || typeof graph !== 'object') throw new Error('出图工作流格式不对（不是节点图）');

        const resp = await fetch('/api/sd/comfy/generate', {
            method: 'POST',
            headers,
            body: JSON.stringify({ url: sd.comfy_url || DEFAULT_COMFY_URL, prompt: JSON.stringify({ prompt: graph }) }),
        });
        if (!resp.ok) throw new Error('出图失败: ' + (await resp.text()).slice(0, 300));
        const { format, data } = await resp.json();
        if (!data) throw new Error('出图返回空数据');
        return { format: format || 'png', data };
    }

    // ------------------------------------------------------------- 头像 ------
    function base64ToBlob(b64, format) {
        const bin = atob(b64);
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : 'image/png' });
    }

    function safeSlug(text) {
        let h = 5381;
        const s = String(text || '');
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return h.toString(16);
    }

    /** 把旧头像备份进 user/files（服务端只允许 ASCII 文件名） */
    async function backupAvatar(fetchUrl, label) {
        const h = ctx().getRequestHeaders();
        try {
            const r = await fetch(fetchUrl, { cache: 'no-store' });
            if (!r.ok) return '';
            const buf = await r.arrayBuffer();
            let bin = '';
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            const b64 = btoa(bin);
            const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
            const name = 'avatar-backup-' + safeSlug(label) + '-' + ts + '.png';
            const res = await fetch('/api/files/upload', {
                method: 'POST',
                headers: h,
                body: JSON.stringify({ name, data: b64 }),
            });
            if (!res.ok) return '';
            const j = await res.json().catch(() => ({}));
            const path = j.path || ('user/files/' + name);
            console.log('[auto-avatar] 旧头像已备份: ' + path);
            return path;
        } catch (e) {
            console.warn('[auto-avatar] 备份旧头像失败', e);
            return '';
        }
    }

    /** 把生成的那张图设成角色卡头像（卡片文字内容原样回写） */
    async function applyCharacterAvatar(ch, format, data) {
        const c = ctx();
        const d = ch.data || {};
        // 优先用卡文件里原始 JSON 的字段（客户端 hoist 出来的 ch.description 会把 \n 变成 \r\n，
        // 直接用会让每次换头像都改一遍正文换行符）；拿不到再退回客户端字段。
        let orig = {};
        try {
            const jd = ch.json_data;
            if (jd) orig = typeof jd === 'string' ? JSON.parse(jd) : jd;
        } catch (e) { orig = {}; }
        const od = (orig && orig.data) || {};
        const pick = (k, dflt) => (od[k] !== undefined ? od[k] : (d[k] !== undefined ? d[k] : (ch[k] !== undefined ? ch[k] : dflt)));
        const ext = Object.assign({}, od.extensions || d.extensions || {});
        if (ext.world === undefined && ch.world !== undefined) ext.world = ch.world;
        const dp = ext.depth_prompt || {};
        const form = new FormData();
        form.append('ch_name', String(ch.name || (od.name !== undefined ? od.name : '')));
        form.append('description', pick('description', ''));
        form.append('personality', pick('personality', ''));
        form.append('scenario', pick('scenario', ''));
        form.append('first_mes', pick('first_mes', ''));
        form.append('mes_example', pick('mes_example', ''));
        form.append('creator_notes', pick('creator_notes', orig.creatorcomment || ''));
        form.append('system_prompt', pick('system_prompt', ''));
        form.append('post_history_instructions', pick('post_history_instructions', ''));
        form.append('creator', pick('creator', ''));
        form.append('character_version', pick('character_version', ''));
        const tags = pick('tags', []);
        form.append('tags', Array.isArray(tags) ? tags.join(', ') : String(tags || ''));
        form.append('extensions', JSON.stringify(ext));
        const talk = ext.talkativeness !== undefined ? ext.talkativeness : (orig.talkativeness !== undefined ? orig.talkativeness : 0.5);
        form.append('talkativeness', String(talk));
        form.append('world', String(ext.world || ''));
        form.append('depth_prompt_prompt', String(dp.prompt || ''));
        form.append('depth_prompt_depth', String(dp.depth !== undefined ? dp.depth : 4));
        form.append('depth_prompt_role', String(dp.role || 'system'));
        const fav = orig.fav !== undefined ? orig.fav : ch.fav;
        form.append('fav', fav === true || fav === 'true' ? 'true' : 'false');
        for (const g of (Array.isArray(od.alternate_greetings) ? od.alternate_greetings : (Array.isArray(d.alternate_greetings) ? d.alternate_greetings : []))) form.append('alternate_greetings', String(g || ''));
        form.append('avatar_url', String(ch.avatar || ''));
        form.append('chat', String(ch.chat || ''));
        form.append('create_date', String(ch.create_date || ''));
        form.append('json_data', String(ch.json_data || ''));
        const blob = base64ToBlob(data, format);
        form.append('avatar', new File([blob], 'avatar.' + (format === 'jpg' ? 'jpg' : 'png'), { type: blob.type }));

        const resp = await fetch('/api/characters/edit', {
            method: 'POST',
            headers: c.getRequestHeaders({ omitContentType: true }),
            body: form,
            cache: 'no-cache',
        });
        if (!resp.ok) throw new Error('写回角色卡头像失败: ' + (await resp.text()).slice(0, 200));
    }

    /** 当前 persona 的头像文件名；没设置就返回空（此时不画 persona） */
    function personaFile() {
        const c = ctx();
        return String((c.powerUserSettings && c.powerUserSettings.default_persona) || '').trim();
    }

    /** 面板/日志里显示用的 persona 名字；没名字就用中性的 Persona */
    function personaDisplayName() {
        const c = ctx();
        return String(c.name1 || '').trim() || 'Persona';
    }

    /**
     * persona 头像是不是已经是「立绘尺寸」（≥400x600）。
     * 用来防止：已经换过一次头像后，设置被页面旧数据覆盖导致又随机重画一张。
     * 小尺寸的旧图标会被判成 false，从而允许补画一次。
     */
    async function personaAvatarLooksPortrait(file) {
        try {
            const r = await fetch('/User%20Avatars/' + encodeURIComponent(file), { cache: 'no-store' });
            if (!r.ok) return false;
            const blob = await r.blob();
            if (typeof createImageBitmap === 'function') {
                const bmp = await createImageBitmap(blob);
                const ok = bmp.width >= 400 && bmp.height >= 600;
                try { bmp.close(); } catch (e) { /* ignore */ }
                return ok;
            }
            return false;
        } catch (e) { return false; }
    }

    async function applyPersonaAvatar(format, data) {
        const c = ctx();
        const file = personaFile();
        if (!file) throw new Error('当前没有设置 persona 头像文件，跳过');
        const form = new FormData();
        const blob = base64ToBlob(data, format);
        form.append('avatar', new File([blob], 'avatar.' + (format === 'jpg' ? 'jpg' : 'png'), { type: blob.type }));
        form.append('overwrite_name', file);
        const resp = await fetch('/api/avatars/upload', {
            method: 'POST',
            headers: c.getRequestHeaders({ omitContentType: true }),
            body: form,
            cache: 'no-cache',
        });
        if (!resp.ok) throw new Error('写回 persona 头像失败: ' + (await resp.text()).slice(0, 200));
        return file;
    }

    /** 换完头像后刷新页面上的缩略图（服务端缩略图已失效，这里给 img 加时间戳破浏览器缓存） */
    function bustThumbnails(type, file) {
        const fileDec = String(file || '');
        const fileEnc = encodeURIComponent(fileDec);
        const t = Date.now();
        const imgs = document.querySelectorAll('img');
        let n = 0;
        for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            if (!src.includes('thumbnail?')) continue;
            if (!src.includes('type=' + type)) continue;
            const decoded = decodeURIComponent(src);
            if (!decoded.includes(fileDec) && !src.includes(fileEnc)) continue;
            img.setAttribute('src', '/thumbnail?type=' + type + '&file=' + fileEnc + '&t=' + t);
            n++;
        }
        // 角色编辑弹窗里的预览也刷一下
        try {
            const prev = document.querySelector('.avatar_load_preview, #avatar_load_preview');
            if (prev) prev.setAttribute('src', '/thumbnail?type=' + type + '&file=' + fileEnc + '&t=' + t);
        } catch (e) { /* ignore */ }
        return n;
    }

    // ------------------------------------------------------- 选「谁的头像」----
    function detectFirstCharacter(text) {
        const c = ctx();
        const personaName = String(c.name1 || '').trim();
        const body = String(text || '');
        let best = null;
        for (const ch of c.characters || []) {
            const name = String(ch.name || '').trim();
            if (!name || isNonCharacterName(name) || name === personaName) continue;
            if (!ch.avatar || ch.avatar === 'none') continue;
            const idx = body.indexOf(name);
            if (idx < 0) continue;
            if (!best || idx < best.idx) best = { name, avatar: ch.avatar, idx };
        }
        return best;
    }

    function lastAssistantText() {
        const chat = ctx().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system) return String(m.mes || '');
        }
        return '';
    }

    function currentCharacter() {
        const c = ctx();
        const ch = (c.characters || [])[Number(c.characterId)];
        if (!ch || !ch.avatar || ch.avatar === 'none') return null;
        if (isNonCharacterName(String(ch.name || '').trim())) return null;
        return ch;
    }

    // ------------------------------------------------------------ 主流程 -----
    async function drawCharacterCard(ch, reason) {
        if (!ch) throw new Error('没有可画头像的角色卡');
        const name = String(ch.name || '');
        status('正在画「' + name + '」的头像…');
        const { tags, from } = await tagsFor(name);
        const prompt = buildPrompt(tags, 'character');
        console.log('[auto-avatar] 目标=' + name + ' 标签来源=' + from + '\n  prompt=' + prompt);
        const { format, data } = await generatePortrait(prompt, buildNegative());
        const backup = await backupAvatar('/characters/' + encodeURIComponent(String(ch.avatar)), 'char-' + name);
        await applyCharacterAvatar(ch, format, data);
        const busted = bustThumbnails('avatar', String(ch.avatar));
        const s = settings();
        s.lastTarget = '角色：' + name + (from === 'llm' ? '（LLM生成标签）' : '（' + from + '）');
        s.lastAt = Date.now();
        s.lastError = '';
        save();
        refreshLast();
        lastRun = { kind: 'character', name, tags, from, backup, busted, at: Date.now(), reason };
        status('✅ 「' + name + '」头像已更新');
        try { toastr.success('已自动画好「' + name + '」的头像', '自动画头像'); } catch (e) { /* ignore */ }
        return lastRun;
    }

    async function drawPersona(reason) {
        const c = ctx();
        const pu = c.powerUserSettings || {};
        const displayName = personaDisplayName();
        const personaPath = personaFile();
        if (!personaPath) throw new Error('当前没有设置 persona 头像文件，跳过');
        const desc = String(pu.persona_description || '');
        let tags = sanitizeTags(extractSdTags(desc)).join(', ');
        // persona 卡里没有【SD标签】时用一组中性描述，避免写死某个角色的外貌
        if (!tags) tags = 'long hair, casual clothes, gentle expression';
        status('正在画「' + displayName + '」的头像…');
        const prompt = buildPrompt(tags, 'persona');
        console.log('[auto-avatar] persona prompt=' + prompt);
        const { format, data } = await generatePortrait(prompt, buildNegative());
        const backup = await backupAvatar('/User%20Avatars/' + encodeURIComponent(personaPath), 'persona');
        const file = await applyPersonaAvatar(format, data);
        const busted = bustThumbnails('persona', file);
        const s = settings();
        s.personaDone = true;
        s.personaAt = Date.now();
        s.lastTarget = displayName + ' persona（' + file + '）';
        s.lastAt = Date.now();
        s.lastError = '';
        save();
        refreshLast();
        lastRun = { kind: 'persona', name: displayName, tags, backup, busted, file, at: Date.now(), reason };
        status('✅ 「' + displayName + '」头像已更新');
        try { toastr.success('已自动画好「' + displayName + '」的头像', '自动画头像'); } catch (e) { /* ignore */ }
        return lastRun;
    }

    /** 第一轮：画正文里最先出现的角色；没卡就退回当前聊天角色；可选再画 persona */
    async function runFirstRound(reason) {
        const s = settings();
        if (!s.enabled) return { skipped: 'disabled' };
        if (busy) return { skipped: 'busy' };
        const m = meta();
        if (m && (m.done || m.attempted)) return { skipped: 'already', meta: m };
        busy = true;
        setMeta({ attempted: true, at: Date.now(), reason: reason || '' });
        try {
            const text = lastAssistantText();
            const hit = detectFirstCharacter(text);
            const ch = hit ? (ctx().characters || []).find((x) => String(x.name || '').trim() === hit.name) : null;
            const target = ch || currentCharacter();
            let res = null;
            if (s.drawOnFirstRound && target) {
                res = await drawCharacterCard(target, reason);
                setMeta({ done: true, name: target.name, avatar: target.avatar, at: Date.now(), source: hit ? 'first-in-text' : 'current-character' });
            } else {
                setMeta({ done: true, name: '', note: '没有匹配到角色卡', at: Date.now() });
                status('这一轮没有匹配到有角色卡的出场角色，跳过');
            }
            if (s.drawPersona && !s.personaDone && personaFile()) {
                // 已经是立绘尺寸 → 说明画过了（可能是设置被旧数据覆盖），直接标记跳过
                if (await personaAvatarLooksPortrait(personaFile())) {
                    s.personaDone = true;
                    s.personaAutoDetected = true;
                    save();
                    refreshLast();
                } else {
                    try { await drawPersona(reason); } catch (e) {
                        s.lastError = 'persona 头像失败: ' + (e.message || e); save(); refreshLast();
                        console.warn('[auto-avatar] persona 头像失败', e);
                    }
                }
            }
            return res || { ok: true };
        } catch (e) {
            const s2 = settings();
            s2.lastError = String(e.message || e).slice(0, 300);
            s2.lastAt = Date.now();
            save();
            refreshLast();
            setMeta({ done: true, error: String(e.message || e).slice(0, 300), at: Date.now() });
            status('❌ 画头像失败：' + (e.message || e));
            console.error('[auto-avatar]', e);
            return { error: String(e.message || e) };
        } finally {
            busy = false;
        }
    }

    function isFirstRound() {
        const c = ctx();
        const chat = c.chat || [];
        if (!chat.length || chat.length > 6) return false;
        const hasUser = chat.some((x) => x && x.is_user && !x.is_system);
        if (!hasUser) return false;
        const last = chat[chat.length - 1];
        if (!last || last.is_user || last.is_system) return false;
        return true;
    }

    function onReply(reason) {
        if (busy || pending) return;
        const s = settings();
        const md = meta();
        if (!s.enabled || !s.drawOnFirstRound) return;
        if (md && (md.done || md.attempted)) return;
        if (!isFirstRound()) return;
        pending = true;
        setTimeout(async () => {
            pending = false;
            try { await runFirstRound(reason); } catch (e) { console.warn('[auto-avatar]', e); }
        }, 2500);
    }

    // -------------------------------------------------------------- 面板 -----
    function buildPanel() {
        if (document.getElementById('aa-panel')) return;
        const host = document.getElementById('extensions_settings');
        if (!host) return;
        const s = settings();
        const div = document.createElement('div');
        div.id = 'aa-panel';
        div.className = 'extension_container';
        div.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>自动画头像（SDXL）</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="aa-enabled" ${s.enabled ? 'checked' : ''}>
                        <span>启用（新会话第一轮自动画「正文里最先出现的角色」的头像并替换角色卡头像）</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="aa-first" ${s.drawOnFirstRound ? 'checked' : ''}>
                        <span>第一轮自动画角色头像</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="aa-persona" ${s.drawPersona ? 'checked' : ''}>
                        <span>顺带给当前 persona 画头像（只画一次；默认关）</span>
                    </label>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>尺寸</span>
                        <input type="number" id="aa-w" class="text_pole" min="384" max="1536" step="64" style="width:76px;" value="${s.width}">
                        <span>×</span>
                        <input type="number" id="aa-h" class="text_pole" min="384" max="1536" step="64" style="width:76px;" value="${s.height}">
                        <span>｜工作流</span>
                        <input type="text" id="aa-wf" class="text_pole" style="width:190px;" value="${String(s.workflow || '').replace(/"/g, '&quot;')}">
                    </div>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>额外提示词</span>
                        <input type="text" id="aa-extra" class="text_pole" style="flex:1 1 200px;" placeholder="例如 smile, soft smile" value="${String(s.promptExtra || '').replace(/"/g, '&quot;')}">
                    </div>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>世界书</span>
                        <input type="text" id="aa-lorebooks" class="text_pole" style="flex:1 1 220px;min-width:0;" placeholder="书名，逗号分隔；留空 = 只用角色卡描述" value="${listSetting(s.lorebooks).join(', ').replace(/"/g, '&quot;')}">
                    </div>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>对话隔离标记</span>
                        <input type="text" id="aa-chatscope" class="text_pole" style="width:130px;" placeholder="可选" value="${String(s.chatScopeTag || '').replace(/"/g, '&quot;')}">
                        <span style="margin-left:8px;">跳过名字</span>
                        <input type="text" id="aa-skipnames" class="text_pole" style="flex:1 1 150px;min-width:0;" placeholder="可选，逗号分隔" value="${String(s.skipNames || '').replace(/"/g, '&quot;')}">
                    </div>
                    <div class="flex-container flexGap5" style="flex-wrap:wrap;">
                        <div id="aa-now" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">给当前会话第一个角色画头像</div>
                        <div id="aa-persona-now" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">重画 persona 头像</div>
                        <span id="aa-status" style="font-size:12px;opacity:.75;flex:1 1 120px;min-width:0;line-height:1.4;"></span>
                    </div>
                    <div id="aa-last" style="font-size:11px;opacity:.6;margin-top:6px;line-height:1.4;word-break:break-word;"></div>
                    <small style="opacity:.6;display:block;margin-top:6px;">
                        头像走 SDXL（ComfyUI 桥接，和 /imagine 同一条队列）。生成前会把旧头像备份到 user/files/avatar-backup-*.png；角色卡的文字设定原样保留，只换图。
                        提示词优先用上面配置的世界书里该角色的【SD标签】；世界书留空时只用角色卡描述。
                    </small>
                </div>
            </div>`;
        host.appendChild(div);

        const bind = (id, ev, fn) => { const el = div.querySelector(id); if (el) el.addEventListener(ev, fn); };
        bind('#aa-enabled', 'change', (e) => { settings().enabled = e.target.checked; save(); status(e.target.checked ? '已开启自动画头像' : '已暂停'); });
        bind('#aa-first', 'change', (e) => { settings().drawOnFirstRound = e.target.checked; save(); });
        bind('#aa-persona', 'change', (e) => { settings().drawPersona = e.target.checked; save(); });
        bind('#aa-w', 'change', (e) => { settings().width = Math.max(384, Number(e.target.value) || 832); save(); });
        bind('#aa-h', 'change', (e) => { settings().height = Math.max(384, Number(e.target.value) || 1216); save(); });
        bind('#aa-wf', 'change', (e) => { settings().workflow = String(e.target.value || '').trim(); save(); });
        bind('#aa-extra', 'change', (e) => { settings().promptExtra = String(e.target.value || '').trim(); save(); });
        bind('#aa-lorebooks', 'change', (e) => { settings().lorebooks = listSetting(e.target.value); save(); });
        bind('#aa-chatscope', 'change', (e) => { settings().chatScopeTag = String(e.target.value || '').trim(); save(); });
        bind('#aa-skipnames', 'change', (e) => { settings().skipNames = String(e.target.value || '').trim(); save(); });
        bind('#aa-now', 'click', async () => {
            if (busy) { status('正在画，请稍等…'); return; }
            busy = true;
            try {
                const text = lastAssistantText();
                const hit = detectFirstCharacter(text);
                const ch = hit ? (ctx().characters || []).find((x) => String(x.name || '').trim() === hit.name) : null;
                const target = ch || currentCharacter();
                if (!target) { status('当前消息里没有匹配到有角色卡的出场角色'); return; }
                await drawCharacterCard(target, 'manual');
            } catch (e) { status('❌ ' + (e.message || e)); }
            finally { busy = false; }
        });
        bind('#aa-persona-now', 'click', async () => {
            if (busy) { status('正在画，请稍等…'); return; }
            busy = true;
            try { await drawPersona('manual'); } catch (e) { status('❌ ' + (e.message || e)); }
            finally { busy = false; }
        });
        status('就绪');
        refreshLast();
    }

    // -------------------------------------------------------------- 启动 -----
    jQuery(async () => {
        await new Promise((r) => setTimeout(r, 3500));
        try {
            const c = ctx();
            c.eventSource.on(c.eventTypes.CHARACTER_MESSAGE_RENDERED, () => onReply('new reply'));
            c.eventSource.on(c.eventTypes.MESSAGE_SWIPED, () => onReply('swipe'));
            buildPanel();
            console.log('[auto-avatar] v' + VERSION + ' 已加载（第一轮自动画头像，persona 可选）');
        } catch (e) {
            console.error('[auto-avatar] 初始化失败', e);
        }
    });

    // 调试 / 自动化
    window.__DSH_AUTO_AVATAR = {
        version: VERSION,
        state: () => ({
            enabled: settings().enabled,
            drawOnFirstRound: settings().drawOnFirstRound,
            drawPersona: settings().drawPersona,
            personaDone: settings().personaDone,
            busy,
            pending,
            chatId: String((ctx() || {}).chatId || ''),
            chatLength: String((ctx() || {}).chat || []).length,
            meta: meta(),
            lastTarget: settings().lastTarget,
            lastError: settings().lastError,
            lastRun,
        }),
        detect: (text) => detectFirstCharacter(text === undefined ? lastAssistantText() : text),
        run: (reason) => runFirstRound(reason || 'debug'),
        character: (name) => {
            const ch = (ctx().characters || []).find((x) => String(x.name || '').trim() === name);
            if (!ch) return Promise.resolve({ error: '没有角色卡: ' + name });
            return drawCharacterCard(ch, 'debug');
        },
        persona: () => drawPersona('debug'),
        tagsFor: (name) => tagsFor(name),
        promptFor: async (name) => buildPrompt((await tagsFor(name)).tags, 'character'),
    };
})();

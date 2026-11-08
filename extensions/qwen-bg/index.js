/**
 * Qwen 背景图 (qwen-bg) v3.4.2
 *
 * 目标：每条 AI 回复后都「先判断场景有没有变」，只有变了才用 Qwen-Image 2.1 重画背景。
 *
 * 主页背景（v3.3.0）：欢迎页 / 最近聊天页面固定显示 settings.homeBg 里的那张图。
 *   ST 从聊天退回主页时会把聊天背景层清空，主页会露出全局背景（默认透明）；
 *   现在扩展在 CHAT_CHANGED / 页面加载时把主页图铺到背景层上，退回主页立刻换上，
 *   不会再残留上一个聊天的场景背景。面板里可以关掉或换成任意 backgrounds 里的文件。
 *   v3.4.0：兼容 SillyTavern 1.19——1.19 移除了 #bg_custom 图层，改为统一使用 #bg1；
 *   背景层用 homeBgLayer() 动态取（有 #bg_custom 用旧的，没有就用 #bg1）。
 *
 * 判断引擎（按顺序尝试，可在面板里固定）：
 *   1) local：本地 llama-server 8030（qwen3-1.7b，由 bridge-watchdog 拉起），快、免费；
 *   2) main：走 ST 主模型（DeepSeek，generateRaw）判断 —— 本地模型不在线时自动兜底，
 *      所以不会再出现「检测模型离线 → 背景永远不换」。
 *   判断结果 = { changed, scene }，其中 scene 是当前场景的英文关键词。
 *
 * 触发流程：AI 回复 → 判断 changed? → (changed) → 等显存空闲（不跟角色图抢）→
 *          DeepSeek 写画面提示词 → Qwen 出图 → 上传 → 切背景。
 *
 * 每段聊天单独记住：场景关键词 / 上次背景文件 / 上次换背景时间（sceneByChat 等），
 * 切回某段聊天时自动恢复那段聊天上次用的背景。
 *
 * 依赖：ComfyUI(8188) + 桥接(8189) + Qwen-Image 2.1；本地检测模型可选。
 * 删除本文件夹即可完全移除。
 */
(function () {
    'use strict';

    const MODULE = 'qwen-bg';
    const VERSION = '3.4.2';

    // ---------------------------------------------------------------- 部署地址 --
    // 集中在这里，换机器 / 换端口只改这两行（面板里也能覆盖 detectorUrl，
    // ComfyUI 地址会优先读 ST 生图扩展里的 sd.comfy_url）。
    // ComfyUI 桥接：ST 的 /api/sd/comfy/* 把出图请求转发到这里（默认本机 8189）。
    const DEFAULT_COMFY_URL = 'http://127.0.0.1:8189';
    // 本地场景判断模型：llama-server，OpenAI 兼容接口（默认本机 8030）。
    const DEFAULT_DETECTOR_URL = 'http://127.0.0.1:8030';

    const DEFAULTS = {
        enabled: true,
        detectEngine: 'main',                 // main（主模型判断，最准）| auto（本地优先，失败用主模型）| local
        detectorUrl: DEFAULT_DETECTOR_URL,    // 本地 llama-server（默认 qwen3-1.7b）
        detectorModel: 'qwen3-1.7b',
        chatWindow: 6,                        // 送给判断模型的最近消息条数
        everyN: 10,                           // 兜底：连续 N 条判断都没换场景也强制换一次
        minBgInterval: 60000,                 // 两次换背景的最小间隔（毫秒）
        judgeOnChatOpen: true,                // 打开已有内容的聊天时，判断并补一张当前场景背景
        renderer: 'sdxl',                     // sdxl（稳、快，默认）| auto（先 Qwen，不行再 SDXL）| qwen（精细但吃显存）
        width: 1216,
        height: 832,
        negative: 'people, person, human, character, text, watermark, lowres, blurry, worst quality',
        prefix: 'masterpiece, best quality, highly detailed background, scenery, no humans, ',
        counter: 0,
        lastScene: '',
        lastFile: '',
        // 主页（欢迎页 / 最近聊天）固定背景：文件名，放在 backgrounds\ 里；
        // 回到首页时扩展会把它铺在背景层（#bg_custom 或 #bg1）上，防止上一个聊天的背景残留。
        // 默认留空 = 不固定主页背景；在面板里填文件名或点「用当前背景」即可。
        homeBg: '',
        homeBgEnabled: false,
        lastBgAt: 0,
        lastPrompt: '',
        lastDecision: '',
        lastEngine: '',
        sceneByChat: {},                      // chatId -> 最近一次判断出的场景关键词
        bgFileByChat: {},                     // chatId -> 这段聊天当前使用的背景文件名
        bgAtByChat: {},                       // chatId -> 上次换背景时间戳
    };

    // Qwen-Image 2.1 工作流（与 user/workflows/Qwen-Background.json 一致）
    const WF_TEMPLATE = {
        '11': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' } },
        '12': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_w4a8.safetensors', type: 'qwen_image' } },
        '13': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
        '14': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['11', 0], shift: 3.1 } },
        '15': { class_type: 'CLIPTextEncode', inputs: { clip: ['12', 0], text: '%prompt%' } },
        '16': { class_type: 'CLIPTextEncode', inputs: { clip: ['12', 0], text: '%negative_prompt%' } },
        '17': { class_type: 'EmptySD3LatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
        '18': {
            class_type: 'KSampler',
            inputs: {
                model: ['14', 0], positive: ['15', 0], negative: ['16', 0], latent_image: ['17', 0],
                seed: '%seed%', steps: 20, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
            },
        },
        '19': { class_type: 'VAEDecode', inputs: { samples: ['18', 0], vae: ['13', 0] } },
        '20': { class_type: 'SaveImage', inputs: { images: ['19', 0], filename_prefix: 'Qwen_Background' } },
    };

    // SDXL 背景工作流（和角色图同一个 checkpoint，轻量、稳定；没有人物）
    const SDXL_TEMPLATE = {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
        '2': { class_type: 'VAELoader', inputs: { vae_name: 'sdxl_vae.safetensors' } },
        '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: '%prompt%' } },
        '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: '%negative_prompt%' } },
        '5': { class_type: 'EmptyLatentImage', inputs: { batch_size: 1, height: '%height%', width: '%width%' } },
        '6': {
            class_type: 'KSampler',
            inputs: {
                cfg: '%scale%', denoise: 1, latent_image: ['5', 0], model: ['1', 0],
                negative: ['4', 0], positive: ['3', 0], sampler_name: 'dpmpp_2m', scheduler: 'karras',
                seed: '%seed%', steps: '%steps%',
            },
        },
        '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['2', 0] } },
        '8': { class_type: 'SaveImage', inputs: { filename_prefix: 'ST_BG', images: ['7', 0] } },
    };

    const BG_PROMPT = [
        'Describe ONLY the physical surroundings of the current scene as a single comma-separated list of concise English visual keywords.',
        'Focus on the LOCATION and what is actually there: type of place (street, alley, room, tavern, forest...), architecture/materials, furniture/props, light sources, time of day, weather, colors, atmosphere.',
        'Do NOT describe any person, character, body part, or action. Do NOT write sentences. Do NOT add explanations.',
        'Do NOT default to sky/skyline/starry night: the keywords must come from the scene text (e.g. an alley scene = alley walls, brick, dripping pipe, one oil lamp, wet cobblestone, garbage, closed shutters).',
        'Example: narrow medieval alley, night, single oil lamp, wet cobblestone, peeling plaster walls, shuttered windows, dangling sign, puddles reflecting lamplight, fog, grim atmosphere',
    ].join(' ');

    const DETECT_SYSTEM = [
        'You track the SCENE of a roleplay: location, surroundings, time of day, weather, lighting.',
        'Compare the newest narration with the CURRENT SCENE and decide whether the place changed.',
        'STOP and set changed=true if any of these happen:',
        '- someone enters or leaves a building/room, or walks/drives/travels to another place;',
        '- the narration names a different place (tavern, street, forest, bedroom, cave, ship...);',
        '- a large time skip or the weather/lighting clearly changes (day→night, rain starts, fire goes out).',
        'Keep changed=false if: still the same place, only dialogue, emotions, small gestures or movements.',
        'Also output scene: up to 12 comma-separated ENGLISH visual keywords describing the CURRENT scenery (no people, no body parts).',
        'RULE: when changed=true, the scene MUST describe the NEW place — never repeat the old location keywords.',
        'RULE: when changed=false, keep the previous keywords (you may add details visible in the narration).',
        'Do NOT copy the example keywords; describe THIS scene in your own words.',
        'Examples:',
        '{"changed":true,"scene":"open market square, canvas stalls, midday sun, stone fountain"}',
        '{"changed":false,"scene":"small attic room, sloped ceiling, dusty window, single bed"}',
        'Reply with ONLY this JSON, no markdown, no explanation.',
    ].join('\n');

    let busy = false;
    let detecting = false;
    let pendingJudge = false;
    let judgeTimer = 0;
    let localFailAt = 0;          // 本地检测模型最近一次失败时间（失败后 3 分钟内直接用主模型）
    let lastLocalOk = 0;

    const ctx = () => window.SillyTavern.getContext();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function settings() {
        const c = ctx();
        if (!c.extensionSettings[MODULE] || typeof c.extensionSettings[MODULE] !== 'object') {
            c.extensionSettings[MODULE] = {};
        }
        // 注意：必须复用同一个对象（不能每次 Object.assign 出新对象），
        // 否则外部拿到的 s 会被后续 settings() 调用替换掉，赋值全部丢失。
        const s = c.extensionSettings[MODULE];
        for (const k of Object.keys(DEFAULTS)) {
            if (s[k] === undefined) s[k] = DEFAULTS[k];
        }
        // 旧版本字段兼容
        if (!s.sceneByChat || typeof s.sceneByChat !== 'object') s.sceneByChat = {};
        if (!s.bgFileByChat || typeof s.bgFileByChat !== 'object') s.bgFileByChat = {};
        if (!s.bgAtByChat || typeof s.bgAtByChat !== 'object') s.bgAtByChat = {};
        return s;
    }

    function save() {
        try { ctx().saveSettingsDebounced?.(); } catch (e) { /* ignore */ }
    }

    function status(text) {
        const el = document.getElementById('qwenbg-status');
        if (el) el.textContent = text;
        console.log('[qwen-bg] ' + text);
    }

    function setDecision(text) {
        const s = settings();
        s.lastDecision = String(text || '');
        save();
        const el = document.getElementById('qwenbg-lastdecision');
        if (el) el.textContent = '上次判断：' + s.lastDecision;
    }

    function chatKey() {
        const c = ctx();
        return String(c.chatId || c.groupId || c.name2 || 'default');
    }

    function chatRec() {
        const s = settings();
        const k = chatKey();
        const rec = {
            key: k,
            scene: String(s.sceneByChat[k] || ''),
            file: String(s.bgFileByChat[k] || ''),
            at: Number(s.bgAtByChat[k] || 0),
        };
        // 供面板/兼容旧字段使用
        s.lastScene = rec.scene;
        s.lastFile = rec.file;
        s.lastBgAt = rec.at;
        return rec;
    }

    function rememberChat(recPatch) {
        const s = settings();
        const k = chatKey();
        if (recPatch.scene !== undefined) s.sceneByChat[k] = recPatch.scene;
        if (recPatch.file !== undefined) s.bgFileByChat[k] = recPatch.file;
        if (recPatch.at !== undefined) s.bgAtByChat[k] = recPatch.at;
        chatRec();
        save();
    }

    // ---------------------------------------------------------------- 文本工具 --
    function filterPrompt(raw) {
        let s = String(raw || '');
        s = s.replace(/[\r\n]+/g, ', ');
        s = s.replace(/^[^:]*:\s*/, '');
        s = s.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, ' ');
        s = s.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
        s = s.replace(/^,|,$/g, '').trim();
        return s;
    }

    function recentLines(n) {
        const c = ctx();
        const chat = c.chat || [];
        return chat
            .filter((m) => !m.is_system && (m.mes || m.message))
            .filter((m) => String(m.name || '') !== 'SillyTavern System')
            .filter((m) => !/sends a picture/i.test(String(m.mes || m.message)))
            .slice(-n)
            .map((m) => `${m.is_user ? (c.name1 || 'User') : (m.name || 'Char')}: ${String(m.mes || m.message).slice(0, 600)}`);
    }

    /**
     * 送给主模型的文本只做通用清理：按句子切分、丢掉过短的碎片、限制总长度。
     * 背景判断只关心「地点/时间/天气/光线」，裁剪不会损失这类信息。
     * 注意：公开版不内置任何内容审查词表；如果所用主模型对某些题材敏感，
     * 请在模型 / 提供方侧处理，或改用本地判断引擎。
     */
    function sanitizeForModel(text) {
        const src = String(text || '').replace(/\r/g, '');
        const parts = src.split(/[。；;\n]+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0) return '';
        const keep = parts.filter((s) => s.length >= 4);
        return keep.slice(-40).join('。').slice(-1600);
    }

    /** 场景关键词清理：Qwen-Image 的文本编码器懂中文，中英都收；只去掉界面/系统噪声词 */
    function sanitizeScene(raw) {
        let s = filterPrompt(raw || '');
        if (!s) return '';
        s = s.replace(/\b(sillytavern|system|button|menu|drawer|settings|option|dropdown|panel)\b[,\s]*/gi, '');
        s = s.replace(/(sillytavern|系统|按钮|菜单|抽屉|设置|选项)[,，\s]*/gi, '');
        s = s.replace(/\b\d+\s*(women|men|people|girls?|boys?)\b[,\s]*/gi, '');
        s = s.slice(0, 200).replace(/^[,，\s]+|[,，\s]+$/g, '').trim();
        return s.length >= 6 ? s : '';
    }

    function parseJsonLoose(text) {
        const m = String(text || '').match(/\{[\s\S]*\}/);
        if (!m) return null;
        try { return JSON.parse(m[0]); } catch (e) { return null; }
    }

    // ---------------------------------------------------------------- 本地检测模型 --
    async function fetchWithTimeout(url, init, ms) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        try {
            return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
        } finally {
            clearTimeout(timer);
        }
    }

    async function detectorAlive() {
        const s = settings();
        const url = String(s.detectorUrl || '').replace(/\/$/, '');
        if (!url) return false;
        try {
            const r = await fetchWithTimeout(url + '/health', { method: 'GET' }, 3500);
            return r.ok;
        } catch (e) {
            return false;
        }
    }

    async function askLocalDetector() {
        const s = settings();
        const url = String(s.detectorUrl || '').replace(/\/$/, '');
        const rec = chatRec();
        const userMsg = 'CURRENT SCENE: ' + (rec.scene || '(unknown)')
            + '\n\nNEWEST NARRATION:\n' + recentLines(Number(s.chatWindow) || 6).join('\n')
            + '\n\nIMPORTANT: "scene" MUST be ENGLISH comma-separated keywords. Translate any Chinese into English.'
            + '\nReturn the JSON now.';
        const r = await fetchWithTimeout(url + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: s.detectorModel,
                messages: [
                    { role: 'system', content: DETECT_SYSTEM },
                    { role: 'user', content: userMsg },
                ],
                max_tokens: 160,
                temperature: 0.1,
                stream: false,
            }),
        }, 25000);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const text = String(j.choices?.[0]?.message?.content || '');
        const d = parseJsonLoose(text);
        if (!d) throw new Error('模型没有返回 JSON: ' + text.slice(0, 80));
        return d;
    }

    // ---------------------------------------------------------------- 主模型检测 --
    async function askMainDetector() {
        const c = ctx();
        if (typeof c.generateRaw !== 'function') throw new Error('当前环境没有 generateRaw');
        const s = settings();
        const rec = chatRec();
        const narration = recentLines(Number(s.chatWindow) || 6)
            .map((line) => sanitizeForModel(line))
            .filter(Boolean)
            .join('\n');
        const prompt = DETECT_SYSTEM
            + '\n\nCURRENT SCENE: ' + (rec.scene || '(unknown)')
            + '\n\nNEWEST NARRATION:\n' + narration
            + '\n\nReturn the JSON now.';
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                // DeepSeek 的思考 token 会吃掉 budget，responseLength 太小会变成空回复（No message generated）
                const raw = await Promise.race([
                    c.generateRaw({
                        prompt,
                        systemPrompt: 'You are a JSON API for a roleplay scene tracker. Reply with ONLY the JSON object, no markdown.',
                        responseLength: 900,
                        quietToLoud: true,
                    }),
                    sleep(45000).then(() => { throw new Error('主模型判断超时 45s'); }),
                ]);
                const d = parseJsonLoose(raw);
                if (!d) throw new Error('主模型没有返回 JSON: ' + String(raw || '').slice(0, 80));
                return d;
            } catch (e) {
                lastErr = e;
                console.warn('[qwen-bg] 主模型判断第 ' + attempt + ' 次失败：', e);
                if (attempt < 3) await sleep(1200 * attempt);
            }
        }
        throw lastErr || new Error('主模型判断失败');
    }

    /**
     * 判断场景是否变化。返回 { changed, scene, engine, sim, tooSoon }。
     * main：主模型（DeepSeek）优先，失败 → 本地 1.5B 兜底；
     * auto：本地 1.5B 优先，失败/离线 → 主模型；
     * local：只用本地。
     */
    async function judgeScene() {
        const s = settings();
        const engine = String(s.detectEngine || 'main').toLowerCase();
        const rec = chatRec();
        let d = null;
        let used = '';
        let lastErr = '';
        const localCooldown = Date.now() - Number(localFailAt || 0) < 3 * 60 * 1000;
        const order = engine === 'local' ? ['local']
            : engine === 'auto' ? ['local', 'main']
                : ['main', 'local'];

        for (const eng of order) {
            if (d) break;
            if (eng === 'local') {
                // auto 模式下最近本地刚失败过 → 先跳过，省时间
                if (engine === 'auto' && localCooldown) continue;
                const alive = await detectorAlive();
                if (!alive) {
                    lastErr = (lastErr ? lastErr + '；' : '') + '本地检测模型离线(8030)';
                    localFailAt = Date.now();
                    continue;
                }
                try {
                    d = await askLocalDetector();
                    used = 'local';
                    lastLocalOk = Date.now();
                } catch (e) {
                    lastErr = (lastErr ? lastErr + '；' : '') + '本地检测失败: ' + (e.message || e);
                    localFailAt = Date.now();
                }
            } else {
                try {
                    d = await askMainDetector();
                    used = 'main';
                } catch (e) {
                    lastErr = (lastErr ? lastErr + '；' : '') + '主模型判断失败: ' + (e.message || e);
                }
            }
        }
        if (!d) throw new Error(lastErr || '没有可用的场景判断引擎');
        const scene = sanitizeScene(d.scene || '');
        const sim = sceneSimilarity(scene, rec.scene);
        const minInt = Math.max(10000, Number(s.minBgInterval) || 60000);
        const tooSoon = Date.now() - Number(rec.at || 0) < minInt;
        // 这段聊天还没有任何背景（我们没给过，ST 里也没有）→ 第一次必须补一张，
        // 不管模型说没说「变了」，否则新聊天永远没有背景。
        let stBg = '';
        try { stBg = String(ctx().chatMetadata?.custom_background || ''); } catch (e) { /* ignore */ }
        const firstTime = !rec.at && !stBg;
        const changed = (!!d.changed || firstTime) && sim < 0.55;
        if (scene) rememberChat({ scene });
        return { changed, scene, engine: used, sim, tooSoon, rawChanged: !!d.changed, firstTime };
    }

    // ---------------------------------------------------------------- 背景生成 ----
    async function renderWithQwen(promptText) {
        const s = settings();
        const seed = Math.floor(Math.random() * 1e9);
        let raw = JSON.stringify(WF_TEMPLATE);
        raw = raw.replace('"%prompt%"', JSON.stringify(s.prefix + promptText));
        raw = raw.replace('"%negative_prompt%"', JSON.stringify(s.negative));
        raw = raw.replace('"%width%"', String(s.width));
        raw = raw.replace('"%height%"', String(s.height));
        raw = raw.replace('"%seed%"', String(seed));
        const wf = JSON.parse(raw);

        const c = ctx();
        const comfyUrl = c.extensionSettings?.sd?.comfy_url || DEFAULT_COMFY_URL;
        const resp = await fetchWithTimeout('/api/sd/comfy/generate', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ url: comfyUrl, prompt: JSON.stringify({ prompt: wf }) }),
        }, 6 * 60 * 1000);
        if (!resp.ok) throw new Error('出图失败: ' + (await resp.text()).slice(0, 200));
        const data = await resp.json();
        return { format: data.format || 'png', b64: data.data };
    }

    /**
     * SDXL 出背景：和角色图同一个 checkpoint、同一个桥接，显存/内存占用小很多，
     * 不会被系统的「显存守卫」打断（Qwen-Image 2.1 的 12G 模型 + 8B 文本编码器
     * 在 16G 卡上经常把内存顶到 97%，守卫一中止，ComfyUI 就报 CUDA error）。
     */
    async function renderWithSdxl(promptText) {
        const s = settings();
        const c = ctx();
        const sd = c.extensionSettings?.sd || {};
        // 默认用 ST 生图设置里的模型；没设置时退回通用的 SDXL 基础模型名，
        // 具体模型以 ST 生图扩展 / 工作流里的配置为准。
        const model = sd.model || 'sd_xl_base_1.0.safetensors';
        const scale = sd.scale || 5.5;
        const steps = sd.steps || 28;
        const seed = Math.floor(Math.random() * 1e9);
        let raw = JSON.stringify(SDXL_TEMPLATE);
        raw = raw.replace('"%model%"', JSON.stringify(model));
        raw = raw.replace('"%prompt%"', JSON.stringify(s.prefix + promptText));
        raw = raw.replace('"%negative_prompt%"', JSON.stringify(s.negative));
        raw = raw.replace('"%width%"', String(s.width));
        raw = raw.replace('"%height%"', String(s.height));
        raw = raw.replace('"%scale%"', String(scale));
        raw = raw.replace('"%steps%"', String(steps));
        raw = raw.replace('"%seed%"', String(seed));
        const wf = JSON.parse(raw);

        const comfyUrl = sd.comfy_url || DEFAULT_COMFY_URL;
        const resp = await fetchWithTimeout('/api/sd/comfy/generate', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ url: comfyUrl, prompt: JSON.stringify({ prompt: wf }) }),
        }, 6 * 60 * 1000);
        if (!resp.ok) throw new Error('出图失败: ' + (await resp.text()).slice(0, 200));
        const data = await resp.json();
        return { format: data.format || 'png', b64: data.data };
    }

    /** ComfyUI 当前空闲显存（GB）；拿不到就返回 null（当作够用） */
    async function comfyVramFreeGB() {
        try {
            const c = ctx();
            const comfy = String(c.extensionSettings?.sd?.comfy_url || DEFAULT_COMFY_URL).replace(/\/$/, '');
            const r = await fetchWithTimeout(comfy + '/system_stats', {}, 5000);
            if (!r.ok) return null;
            const j = await r.json();
            const d = (j.devices || [])[0];
            if (!d) return null;
            return Number(d.vram_free) / 1073741824;
        } catch (e) {
            return null;
        }
    }

    async function comfyFree() {
        try {
            const c = ctx();
            const comfy = String(c.extensionSettings?.sd?.comfy_url || DEFAULT_COMFY_URL).replace(/\/$/, '');
            await fetchWithTimeout(comfy + '/free', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ unload_models: true, free_memory: true }),
            }, 15000);
        } catch (e) { /* ignore */ }
    }

    /** 按设置选择出图模型：sdxl / auto（Qwen 优先，放不下或失败就 SDXL）/ qwen */
    async function renderBackground(promptText) {
        const mode = String(settings().renderer || 'sdxl').toLowerCase();
        if (mode === 'sdxl') return renderWithSdxl(promptText);
        if (mode === 'qwen') {
            let free = await comfyVramFreeGB();
            if (free !== null && free < 11) {
                status('显存只有 ' + free.toFixed(1) + 'GB，先卸载 ComfyUI 模型…');
                await comfyFree();
                await sleep(2000);
                free = await comfyVramFreeGB();
            }
            const img = await renderWithQwen(promptText);
            return img;
        }
        // auto
        let free = await comfyVramFreeGB();
        if (free !== null && free < 10.5) {
            try { await comfyFree(); await sleep(2000); } catch (e) { /* ignore */ }
            free = await comfyVramFreeGB();
        }
        if (free !== null && free < 10.5) {
            console.warn('[qwen-bg] 显存不足（' + free.toFixed(1) + 'GB），这次用 SDXL 出背景');
            return renderWithSdxl(promptText);
        }
        try {
            return await renderWithQwen(promptText);
        } catch (e) {
            console.warn('[qwen-bg] Qwen 出图失败，改用 SDXL：', e);
            return renderWithSdxl(promptText);
        }
    }

    async function uploadBackground(b64, format) {
        const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const blob = new Blob([bin], { type: 'image/' + format });
        const fd = new FormData();
        fd.append('avatar', blob, `qwenbg_${Date.now()}.${format}`);
        const c = ctx();
        const resp = await fetch('/api/backgrounds/upload', {
            method: 'POST',
            headers: c.getRequestHeaders({ omitContentType: true }),
            body: fd,
            cache: 'no-cache',
        });
        if (!resp.ok) throw new Error('上传背景失败: HTTP ' + resp.status);
        return (await resp.text()).trim();
    }

    async function applyBackground(file) {
        const c = ctx();
        // 已经是这张图就不要再发事件：ST 的 forceSetBackground 每次都会往
        // chat_metadata 的背景列表里 push 一条，重复发会导致同一张图堆很多条。
        try {
            const cur = String(homeBgLayer()?.style?.backgroundImage || '');
            if (cur.includes(file)) return;
        } catch (e) { /* ignore */ }
        await c.eventSource.emit(c.event_types.FORCE_SET_BACKGROUND, {
            url: `url("/backgrounds/${file}")`,
            path: file,
        });
    }

    /**
     * 换新背景后，把这段聊天刚才用的旧背景文件删掉（只在没有别的聊天还引用它时）。
     * 背景图是「随时可删」类：每段聊天只需要当前那一张，旧的留着只会越攒越多。
     */
    async function deleteReplacedBackground(c, oldFile) {
        try {
            const f = String(oldFile || '').trim();
            if (!/^qwenbg_\d+\.(?:png|jpg|jpeg|webp)$/i.test(f)) return;
            const s = settings();
            const curKey = chatKey();
            for (const [k, v] of Object.entries(s.bgFileByChat || {})) {
                if (k !== curKey && String(v) === f) return; // 别的聊天还在用
            }
            const resp = await fetch('/api/backgrounds/delete', {
                method: 'POST',
                headers: c.getRequestHeaders(),
                body: JSON.stringify({ bg: f }),
            });
            if (resp.ok) console.log('[qwen-bg] 已删除被替换的旧背景：' + f);
            else console.warn('[qwen-bg] 删除旧背景失败 HTTP ' + resp.status + '：' + f);
        } catch (e) {
            console.warn('[qwen-bg] 删除旧背景出错', e);
        }
    }

    /** 等显存空下来：角色图 / 别人正在出图时，背景图先排队，绝不抢显存 */
    async function waitGpuIdle(maxMs) {
        const limit = maxMs || 180000;
        const t0 = Date.now();
        let waited = false;
        let lastNote = 0;
        while (Date.now() - t0 < limit) {
            let busyNow = false;
            try {
                if (window.__DSH_GEN_GUARD?.sdBusy?.()) busyNow = true;
                if (window.__DSH_GPU_QUEUE?.state?.()?.active) busyNow = true;
            } catch (e) { /* ignore */ }
            if (!busyNow) return !waited ? 'idle' : 'idle-after-wait';
            waited = true;
            // 每 10 秒提示一次就够，别刷屏
            if (Date.now() - lastNote > 10000) {
                lastNote = Date.now();
                status('等待角色图出完再换背景…');
            }
            await sleep(1500);
        }
        return 'timeout';
    }

    async function buildBackgroundPrompt() {
        const c = ctx();
        if (typeof c.generateRaw !== 'function') return '';
        const lines = recentLines(6).map((line) => sanitizeForModel(line)).filter(Boolean).join('\n');
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const raw = await Promise.race([
                    c.generateRaw({
                        prompt: BG_PROMPT + '\n\nConversation:\n' + lines + '\n\nOutput ONLY one line of comma-separated English visual keywords.',
                        systemPrompt: 'You write image prompts. Output only comma-separated English visual keywords, no explanations, no quotes, no sentences.',
                        responseLength: 600,
                        quietToLoud: true,
                    }),
                    sleep(90000).then(() => { throw new Error('写提示词超时 90s'); }),
                ]);
                const t = filterPrompt(raw);
                if (t && t.length >= 3) return t;
                throw new Error('主模型返回空提示词');
            } catch (e) {
                lastErr = e;
                console.warn('[qwen-bg] 主模型写提示词第 ' + attempt + ' 次失败：', e);
                if (attempt < 3) await sleep(1200 * attempt);
            }
        }
        console.warn('[qwen-bg] 主模型写提示词最终失败，改用场景关键词兜底', lastErr);
        return '';
    }

    function isWelcomePage() {
        if (document.querySelector('.welcomePanel')) return true;
        const c = ctx();
        if (!c.chatId && !c.groupId) {
            const nm = String(c.name2 || '').trim();
            if (!nm) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- 主页背景 ----
    /**
     * 主页（欢迎页/最近聊天）固定背景。
     * 用户反馈：从聊天退回主页时，页面背景还是上一个聊天的场景图（旧版扩展会在切聊天时把
     * 上次的背景重新铺回去）。现在改由 ST 自己恢复聊天背景，主页则固定用下面这张，
     * 每次回到主页立刻换上，保证「实时更新」。
     */
    function homeBgFile() {
        const s = settings();
        if (!s.homeBgEnabled) return '';
        return String(s.homeBg || '').trim();
    }

    function homeBgUrl(file) {
        return 'url("/backgrounds/' + encodeURIComponent(file) + '")';
    }

    /**
     * 主页背景铺在哪个图层：ST 1.13/1.14 用 #bg_custom（聊天自定义背景层），
     * 1.19 起 #bg_custom 被移除，聊天/全局背景统一走 #bg1；这里按 DOM 实际情况取。
     */
    function homeBgLayer() {
        return document.getElementById('bg_custom') || document.getElementById('bg1');
    }

    /** 欢迎页 → 铺主页背景；聊天页 → 不动（ST 的 onChatChanged 会恢复/清除聊天背景） */
    function syncHomeBackground() {
        try {
            if (!isWelcomePage()) return 'chat';
            const file = homeBgFile();
            if (!file) return 'none';
            const el = homeBgLayer();
            if (!el) return 'noel';
            const url = homeBgUrl(file);
            if (el.style.backgroundImage !== url) el.style.backgroundImage = url;
            return 'home';
        } catch (e) {
            console.warn('[qwen-bg] 主页背景出错', e);
            return 'err';
        }
    }

    /** 把当前显示的背景文件设成主页背景（面板按钮用） */
    function useCurrentAsHomeBg() {
        try {
            const cur = String(homeBgLayer()?.style?.backgroundImage || '');
            const m = cur.match(/backgrounds\/([^"')]+)/);
            if (!m) { status('当前没有背景可以设为主页背景'); return; }
            const file = decodeURIComponent(m[1]);
            const s = settings();
            s.homeBg = file;
            s.homeBgEnabled = true;
            save();
            syncHomeBackground();
            status('主页背景已设为：' + file);
            const inp = document.getElementById('qwenbg-homebg');
            if (inp) inp.value = file;
        } catch (e) {
            console.warn('[qwen-bg] 设置主页背景失败', e);
            status('设置主页背景失败：' + (e.message || e));
        }
    }

    /** 内容太少（只有开场白/系统消息）时别出背景，否则模型会画"未展开的世界/星空" */
    function chatHasEnoughContent() {
        const c = ctx();
        const chat = (c.chat || [])
            .filter((m) => !m.is_system && String(m.mes || '').trim())
            .filter((m) => !/sends a picture/i.test(String(m.mes)));
        const userCount = chat.filter((m) => m.is_user).length;
        const textLen = chat.reduce((a, m) => a + String(m.mes || '').length, 0);
        return userCount >= 1 && chat.length >= 2 && textLen >= 150;
    }

    async function generateBackground(reason, scene, opts) {
        const manual = !!(opts && opts.manual);
        if (busy) { status('正在生成背景，跳过本次'); return false; }
        const c = ctx();
        if (!c.chat || c.chat.length === 0) { status('当前没有打开的聊天，跳过'); return false; }
        if (!manual && isWelcomePage()) { status('首页/欢迎页不生成背景'); return false; }
        if (!manual && !chatHasEnoughContent()) { status('对话内容太少（只有开场白），先聊两句再换背景'); return false; }
        if (!manual) {
            const gpuState = await waitGpuIdle(180000);
            if (gpuState === 'timeout') { status('显存一直忙（角色图还没出完），本次跳过'); return false; }
        }
        busy = true;
        const myChat = c.chatId;
        const t0 = Date.now();
        try {
            let promptText = '';
            try {
                status('② 正在写画面提示词…');
                promptText = await buildBackgroundPrompt();
            } catch (e) {
                console.warn('[qwen-bg] 写提示词失败，改用场景关键词', e);
            }
            if (!promptText || promptText.length < 3) promptText = filterPrompt(scene || '');
            if (!promptText || promptText.length < 3) throw new Error('场景描述为空');
            const s = settings();
            s.lastPrompt = promptText;
            save();
            const lpEl = document.getElementById('qwenbg-lastprompt');
            if (lpEl) lpEl.textContent = '上次提示词：' + promptText.slice(0, 200);
            const modelName = String(settings().renderer || 'sdxl').toLowerCase() === 'sdxl' ? 'SDXL' : 'Qwen/SDXL';
            status('③ 正在用 ' + modelName + ' 出图…（' + promptText.slice(0, 60) + '…）');
            const img = await renderBackground(promptText);
            if (c.chatId !== myChat) { status('聊天已切换，丢弃本次背景'); return false; }
            status('④ 正在保存背景…');
            const prevFile = chatRec().file;   // 换背景前这张聊天的旧背景（换完删掉，免得越攒越多）
            const file = await uploadBackground(img.b64, img.format);
            await applyBackground(file);
            if (scene) rememberChat({ scene, file, at: Date.now() });
            else rememberChat({ file, at: Date.now() });
            if (prevFile && prevFile !== file) deleteReplacedBackground(c, prevFile).catch(() => { /* ignore */ });
            const secs = ((Date.now() - t0) / 1000).toFixed(1);
            setDecision(`已换背景（${reason}，${secs}s）`);
            status(`✅ 背景已更新（${secs}s）[${reason}]`);
            return true;
        } catch (e) {
            console.error('[qwen-bg]', e);
            setDecision(`生成失败：${(e.message || e)}`);
            status('❌ ' + (e.message || e));
            return false;
        } finally {
            busy = false;
        }
    }

    // ---------------------------------------------------------------- 相似度 ----
    function tokens(text) {
        return new Set(String(text || '').toLowerCase().split(/[,，、;；\s]+/).map((x) => x.trim()).filter((x) => x.length > 1));
    }
    function sceneSimilarity(a, b) {
        const A = tokens(a); const B = tokens(b);
        if (!A.size || !B.size) return 0;
        let inter = 0;
        for (const x of A) if (B.has(x)) inter++;
        return inter / Math.max(A.size, B.size);
    }

    // ---------------------------------------------------------------- 主流程 ----
    /** 判断一次；changed 就换背景（受最小间隔限制，冷却结束会自动补一次判断） */
    async function checkScene(reason) {
        const s = settings();
        if (!s.enabled) return;
        const c = ctx();
        if (!c.chat || c.chat.length === 0) return;
        if (isWelcomePage()) { setDecision('欢迎页，不判断'); return; }
        if (!chatHasEnoughContent()) { setDecision('内容太少，不判断'); return; }
        if (detecting) { pendingJudge = true; return; }
        detecting = true;
        const myChat = c.chatId;
        try {
            const d = await judgeScene();
            if (c.chatId !== myChat) { setDecision('聊天已切换，丢弃判断'); return; }
            s.lastEngine = d.engine;
            if (d.rawChanged && d.tooSoon) {
                const rec = chatRec();
                const waitMs = Math.max(5000, (Number(s.minBgInterval) || 60000) - (Date.now() - rec.at) + 1000);
                setDecision(`场景变了，冷却中（${Math.ceil(waitMs / 1000)}s 后补一次）`);
                status(`场景变了，冷却中 ${Math.ceil(waitMs / 1000)}s`);
                clearTimeout(judgeTimer);
                judgeTimer = setTimeout(() => { checkScene('冷却结束'); }, waitMs);
                return;
            }
            if (d.changed) {
                const why = d.firstTime ? '首次补背景' : '场景变化';
                setDecision(`${why} → 换背景（${d.engine}｜相似度 ${d.sim.toFixed(2)}）`);
                status(`🎬 ${why} → 换背景（${d.engine}）`);
                s.counter = 0;
                save();
                await generateBackground(why + ':' + d.engine, d.scene);
                return;
            }
            s.counter = (Number(s.counter) || 0) + 1;
            const everyN = Math.max(1, Number(s.everyN) || 10);
            save();
            if (s.counter >= everyN) {
                s.counter = 0;
                save();
                setDecision(`连续 ${everyN} 条没换场景 → 兜底换一次`);
                status(`连续 ${everyN} 条没换场景 → 兜底换背景`);
                await generateBackground('兜底:' + everyN, d.scene);
            } else {
                setDecision(`场景未变（${d.engine}｜相似度 ${d.sim.toFixed(2)}｜${s.counter}/${everyN}）`);
                status(`不换背景（场景未变，${s.counter}/${everyN}）`);
            }
        } catch (e) {
            console.warn('[qwen-bg] 场景判断失败', e);
            setDecision('判断失败：' + (e.message || e));
            status('⚠️ 场景判断失败：' + (e.message || e));
            // 判断失败也不至于永远不换背景：
            //   · 这段聊天还没有任何背景 → 直接补一张（用最近剧情写词）
            //   · 否则按计数兜底
            const s2 = settings();
            const rec2 = chatRec();
            if (!rec2.at) {
                await generateBackground('判断失败→首次补背景', '');
                return;
            }
            s2.counter = (Number(s2.counter) || 0) + 1;
            save();
            if (s2.counter >= Math.max(1, Number(s2.everyN) || 10)) {
                s2.counter = 0;
                save();
                await generateBackground('判断失败→计数兜底', '');
            }
        } finally {
            detecting = false;
            if (pendingJudge) {
                pendingJudge = false;
                scheduleCheck(1500);
            }
        }
    }

    function scheduleCheck(delay) {
        clearTimeout(judgeTimer);
        judgeTimer = setTimeout(() => { checkScene('事件触发'); }, Math.max(500, Number(delay) || 2500));
    }

    // ---------------------------------------------------------------- 设置面板 ----
    function buildPanel() {
        if (document.getElementById('qwenbg-panel')) return;
        const host = document.getElementById('extensions_settings');
        if (!host) return;
        const s = settings();
        const div = document.createElement('div');
        div.id = 'qwenbg-panel';
        div.className = 'extension_container';
        div.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>背景图（先判断场景，变了才换）</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="qwenbg-enabled" ${s.enabled ? 'checked' : ''}>
                        <span>自动生成聊天背景</span>
                    </label>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>出图模型</span>
                        <select id="qwenbg-renderer" class="text_pole" style="width:auto;">
                            <option value="sdxl" ${s.renderer === 'sdxl' ? 'selected' : ''}>SDXL（稳、快，和角色图同模型）</option>
                            <option value="auto" ${s.renderer === 'auto' ? 'selected' : ''}>自动（先 Qwen，放不下/失败再 SDXL）</option>
                            <option value="qwen" ${s.renderer === 'qwen' ? 'selected' : ''}>Qwen-Image 2.1（更精细，很吃显存/内存）</option>
                        </select>
                    </div>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>判断引擎</span>
                        <select id="qwenbg-engine" class="text_pole" style="width:auto;">
                            <option value="auto" ${s.detectEngine === 'auto' ? 'selected' : ''}>自动（本地模型优先，失败用主模型）</option>
                            <option value="local" ${s.detectEngine === 'local' ? 'selected' : ''}>只用本地模型（8030）</option>
                            <option value="main" ${s.detectEngine === 'main' ? 'selected' : ''}>只用主模型（DeepSeek）</option>
                        </select>
                    </div>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>最小间隔</span>
                        <input type="number" id="qwenbg-interval" class="text_pole" min="10" max="600" style="width:70px;" value="${Math.round((Number(s.minBgInterval) || 60000) / 1000)}">
                        <span>秒</span>
                        <span style="margin-left:12px;">兜底：连续</span>
                        <input type="number" id="qwenbg-every" class="text_pole" min="1" max="50" style="width:64px;" value="${s.everyN}">
                        <span>条没变也换一次</span>
                    </div>
                    <label class="checkbox_label">
                        <input type="checkbox" id="qwenbg-onopen" ${s.judgeOnChatOpen ? 'checked' : ''}>
                        <span>打开一段有内容的聊天时，判断并补一张当前场景背景</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="qwenbg-homebg-on" ${s.homeBgEnabled ? 'checked' : ''}>
                        <span>主页（最近聊天）固定显示下面这张背景</span>
                    </label>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>主页背景</span>
                        <input type="text" id="qwenbg-homebg" class="text_pole" style="flex:1 1 160px;min-width:0;" value="${String(s.homeBg || '').replace(/"/g, '&quot;')}" placeholder="backgrounds 里的文件名">
                        <div id="qwenbg-homebg-use" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">用当前背景</div>
                        <div id="qwenbg-homebg-apply" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">应用</div>
                    </div>
                    <div class="flex-container flexGap5" style="margin:8px 0;flex-wrap:wrap;align-items:center;">
                        <span>本地检测地址</span>
                        <input type="text" id="qwenbg-deturl" class="text_pole" style="flex:1 1 140px;min-width:0;" value="${s.detectorUrl}">
                    </div>
                    <div class="flex-container flexGap5" style="flex-wrap:wrap;">
                        <div id="qwenbg-judge" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">立即判断（不出图）</div>
                        <div id="qwenbg-now" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">立即换背景</div>
                        <div id="qwenbg-test" class="menu_button" style="flex:0 0 auto;white-space:nowrap;">测试判断引擎</div>
                    </div>
                    <div style="margin-top:6px;font-size:12px;line-height:1.5;">
                        <div id="qwenbg-status" style="opacity:.85;"></div>
                        <div id="qwenbg-lastdecision" style="opacity:.75;word-break:break-word;">上次判断：${s.lastDecision || '(还没判断过)'}</div>
                        <div id="qwenbg-lastprompt" style="opacity:.6;word-break:break-word;">上次提示词：${String(s.lastPrompt || '(无)').slice(0, 200)}</div>
                    </div>
                    <small style="opacity:.6;display:block;margin-top:6px;">
                        每条 AI 回复后先判断场景变没变；变了才用 Qwen 重画背景。角色图正在出时背景图会排队等显存。
                    </small>
                </div>
            </div>`;
        host.appendChild(div);

        div.querySelector('#qwenbg-enabled').addEventListener('change', (e) => {
            settings().enabled = e.target.checked; save();
            status(e.target.checked ? '已开启自动换背景' : '已暂停自动换背景');
        });
        div.querySelector('#qwenbg-engine').addEventListener('change', (e) => {
            settings().detectEngine = e.target.value; save();
            status('判断引擎：' + e.target.value);
        });
        div.querySelector('#qwenbg-interval').addEventListener('change', (e) => {
            settings().minBgInterval = Math.max(10, Number(e.target.value) || 60) * 1000; save();
            status('最小间隔：' + Math.round(settings().minBgInterval / 1000) + 's');
        });
        div.querySelector('#qwenbg-every').addEventListener('change', (e) => {
            settings().everyN = Math.max(1, Number(e.target.value) || 10); save();
            status('兜底：每 ' + settings().everyN + ' 条');
        });
        div.querySelector('#qwenbg-onopen').addEventListener('change', (e) => {
            settings().judgeOnChatOpen = e.target.checked; save();
            status(e.target.checked ? '打开聊天时会补背景' : '打开聊天时不再补背景');
        });
        div.querySelector('#qwenbg-deturl').addEventListener('change', (e) => {
            settings().detectorUrl = String(e.target.value || '').trim(); save();
            status('本地检测地址：' + settings().detectorUrl);
        });
        div.querySelector('#qwenbg-homebg-on').addEventListener('change', (e) => {
            settings().homeBgEnabled = e.target.checked; save();
            syncHomeBackground();
            status(e.target.checked ? '主页固定背景：开' : '主页固定背景：关');
        });
        div.querySelector('#qwenbg-homebg').addEventListener('change', (e) => {
            settings().homeBg = String(e.target.value || '').trim(); save();
            syncHomeBackground();
            status('主页背景：' + (settings().homeBg || '(未设置)'));
        });
        div.querySelector('#qwenbg-homebg-use').addEventListener('click', () => useCurrentAsHomeBg());
        div.querySelector('#qwenbg-homebg-apply').addEventListener('click', () => {
            syncHomeBackground();
            status('主页背景已应用');
        });
        div.querySelector('#qwenbg-renderer').addEventListener('change', (e) => {
            settings().renderer = e.target.value; save();
            status('背景出图模型：' + e.target.value);
        });
        div.querySelector('#qwenbg-judge').addEventListener('click', () => {
            setDecision('手动判断中…');
            checkScene('手动判断');
        });
        div.querySelector('#qwenbg-now').addEventListener('click', () => generateBackground('手动', '', { manual: true }));
        div.querySelector('#qwenbg-test').addEventListener('click', async () => {
            status('测试中…');
            const s2 = settings();
            const alive = await detectorAlive();
            let out = '本地(' + s2.detectorUrl + ')：' + (alive ? '在线' : '离线');
            if (alive) {
                try {
                    const d = await askLocalDetector();
                    out += '｜changed=' + !!d.changed + ' scene=' + (sanitizeScene(d.scene || '') || '(无效)');
                } catch (e) { out += '｜调用失败: ' + (e.message || e); }
            }
            try {
                const d2 = await askMainDetector();
                out += '｜主模型：changed=' + !!d2.changed + ' scene=' + (sanitizeScene(d2.scene || '') || '(无效)');
            } catch (e) { out += '｜主模型失败: ' + (e.message || e); }
            setDecision(out);
            status(out);
        });
    }

    // ---------------------------------------------------------------- 启动 ----
    jQuery(async () => {
        await new Promise((r) => setTimeout(r, 2500));
        try {
            const c = ctx();
            c.eventSource.on(c.eventTypes.CHARACTER_MESSAGE_RENDERED, () => {
                scheduleCheck(2500);
            });
            c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => {
                const s = settings();
                s.counter = 0;
                save();
                chatRec();
                clearTimeout(judgeTimer);
                // 背景恢复交给 ST 自己：FORCE_SET_BACKGROUND 已经把背景写进 chat_metadata，
                // 切回聊天时 ST 的 onChatChanged 会自动还原，这里再发一次只会重复堆元数据。
                // 但主页不同：ST 会把背景层恢复成全局/聊天背景，主页需要固定显示主页背景（见 syncHomeBackground）。
                syncHomeBackground();
                setTimeout(syncHomeBackground, 600);
                const panelFile = document.getElementById('qwenbg-lastdecision');
                if (panelFile) panelFile.textContent = '上次判断：' + (settings().lastDecision || '(还没判断过)');
                if (settings().judgeOnChatOpen) {
                    setTimeout(() => {
                        if (isWelcomePage()) return;
                        const r2 = chatRec();
                        if (r2.file && Date.now() - r2.at < 10 * 60 * 1000) { status('这段聊天刚刚换过背景，跳过'); return; }
                        checkScene('切换聊天');
                    }, 2500);
                } else {
                    status('已切换聊天，场景记忆重置');
                }
            });
            buildPanel();
            const s = settings();
            console.log('[qwen-bg] v' + VERSION + ' 已加载，engine=' + s.detectEngine + ' detector=' + s.detectorUrl + ' 兜底=' + s.everyN);

            // 主页背景：页面一加载（就是欢迎页）就铺上；ST 渲染欢迎页是异步的，多补两次
            syncHomeBackground();
            setTimeout(syncHomeBackground, 800);
            setTimeout(syncHomeBackground, 2500);

            // 页面加载时聊天可能已经打开（扩展加载晚于 CHAT_CHANGED 事件），补一次判断：
            // 有内容、这段聊天还没有背景（或 10 分钟以上没更新）→ 判断后补一张当前场景背景。
            setTimeout(() => {
                try {
                    if (!settings().enabled || !settings().judgeOnChatOpen) return;
                    if (isWelcomePage() || !chatHasEnoughContent()) return;
                    const r = chatRec();
                    if (r.file && Date.now() - r.at < 10 * 60 * 1000) return;
                    checkScene('页面加载');
                } catch (e) { console.warn('[qwen-bg] 加载后检查失败', e); }
            }, 3500);
        } catch (e) {
            console.error('[qwen-bg] 初始化失败', e);
        }
    });

    // 调试工具
    window.__DSH_QWENBG = {
        version: VERSION,
        state: () => {
            const s = settings();
            return {
                enabled: s.enabled, engine: s.detectEngine, counter: s.counter, busy, detecting,
                chat: chatKey(), rec: chatRec(), lastDecision: s.lastDecision, lastEngine: s.lastEngine,
                detectorUrl: s.detectorUrl, localFailAt, lastLocalOk,
            };
        },
        judge: () => checkScene('调试'),
        generate: (reason) => generateBackground(reason || '调试', '', { manual: true }),
        aiMessage: () => scheduleCheck(100),
        setEngine: (v) => { settings().detectEngine = String(v); save(); return settings().detectEngine; },
    };
})();

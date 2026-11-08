/**
 * DSH 本地模型配置 (dsh-model-config) v1.0.1
 *
 * 作用：把这两个「用 LLM 做后台整理」的扩展统一指到本地 Ollama 的 gemma4-e4b：
 *   1. st-memory-enhancement（记忆增强表格）：分步填表/重整理走「备用 API」= 本地 gemma；
 *      表格只读注入、深度 6；每个 AI 回复后自动填表（异步、静默）。
 *   2. AutoCardUpdaterExtension（角色卡自动更新）：API = 本地 gemma；
 *      默认只保留手动更新（自动更新先关着，避免它乱写角色卡世界书）。
 *
 * 另加一个 fetch 拦截器：发到 127.0.0.1:11434 的 /chat/completions 自动补
 * `reasoning_effort: "none"`（实测 Ollama 0.40 里这个字段能关掉 gemma4 的 thinking；
 * 否则模型会把输出全花在 thinking 上，content 是空的）。
 *
 * 模型本身是派生模型：gemma4-e4b-ctx8k（num_ctx 8192 / num_gpu 0=CPU / num_predict 1024）。
 * 删掉本文件夹即可移除本扩展；两个扩展里的设置会保留，可手动改回。
 */
(function () {
    'use strict';

    const VERSION = '1.0.1';
    const CONFIG_TAG = '__dshModelConfig';

    const OLLAMA_BASE = 'http://127.0.0.1:11434';
    const API_URL = OLLAMA_BASE + '/v1';
    const MODEL = 'gemma4-e4b-ctx8k:latest';
    const API_KEY = 'ollama'; // Ollama 不校验，但插件要求非空

    function ctx() {
        try { return window.SillyTavern?.getContext?.() ?? null; } catch (e) { return null; }
    }

    // ---------------------------------------------------------------- fetch 拦截 --
    // 给 Ollama 的 /chat/completions 自动补 reasoning_effort:none（关 thinking）
    function installFetchHook() {
        const orig = window.fetch;
        if (typeof orig !== 'function' || orig.__dshModelHook) return;
        const wrapped = function (input, init) {
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                const isOllamaChat = url.indexOf('11434') >= 0 && /\/chat\/completions/.test(url);
                if (isOllamaChat) {
                    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
                    if (method === 'POST' && init && typeof init.body === 'string') {
                        const obj = JSON.parse(init.body);
                        if (obj && typeof obj === 'object' && obj.reasoning_effort === undefined) {
                            obj.reasoning_effort = 'none';
                            init = Object.assign({}, init, { body: JSON.stringify(obj) });
                        }
                    }
                }
            } catch (e) { /* ignore */ }
            return orig.call(this, input, init);
        };
        wrapped.__dshModelHook = true;
        window.fetch = wrapped;
    }

    // ---------------------------------------------------------------- 本地 key 加密 --
    // 记忆插件的「备用 API Key」是 XOR(设备ID) 加密的，这里按它的算法生成
    function ensureDeviceId() {
        try {
            let id = localStorage.getItem('st_device_id');
            if (!id) {
                const chars = 'abcdef0123456789';
                let rand = '';
                for (let i = 0; i < 32; i++) rand += chars[Math.floor(Math.random() * chars.length)];
                id = 'st-' + Date.now() + '-' + rand;
                localStorage.setItem('st_device_id', id);
            }
            return id;
        } catch (e) {
            return 'st-dsh-fallback-device-id';
        }
    }

    function xorEncrypt(raw, deviceId) {
        return Array.from(String(raw))
            .map((c, i) => (c.charCodeAt(0) ^ deviceId.charCodeAt(i % deviceId.length)).toString(16).padStart(2, '0'))
            .join('');
    }

    // ---------------------------------------------------------------- ACU localStorage --
    // AutoCardUpdater 的配置存在浏览器 localStorage，必须在它加载前写好
    function applyAutoCardUpdater() {
        try {
            const apiConfig = { url: API_URL, apiKey: API_KEY, model: MODEL };
            localStorage.setItem('autoCardUpdater_apiConfig_v1', JSON.stringify(apiConfig));
            if (localStorage.getItem('autoCardUpdater_autoUpdateThreshold_v1') === null) {
                localStorage.setItem('autoCardUpdater_autoUpdateThreshold_v1', '20');
            }
            // 自动更新先关着：手动按钮试过、确认写入内容满意再自己打开
            if (localStorage.getItem('autoCardUpdater_autoUpdateEnabled_v1') === null) {
                localStorage.setItem('autoCardUpdater_autoUpdateEnabled_v1', 'false');
            }
            // 不显示聊天界面上的浮动「角色卡」按钮，少遮挡
            if (localStorage.getItem('autoCardUpdater_viewerEnabled_v1') === null) {
                localStorage.setItem('autoCardUpdater_viewerEnabled_v1', 'false');
            }
        } catch (e) { console.warn('[dsh-model-config] 写 ACU 配置失败', e); }
    }

    // ---------------------------------------------------------------- 记忆插件设置 --
    function applyMemorySettings() {
        try {
            const c = ctx();
            if (!c || !c.powerUserSettings) return false;
            const pu = c.powerUserSettings;
            if (pu[CONFIG_TAG] === VERSION) return true;

            const deviceId = ensureDeviceId();
            pu.IMPORTANT_USER_PRIVACY_DATA = Object.assign({}, pu.IMPORTANT_USER_PRIVACY_DATA || {}, {
                custom_api_url: API_URL,
                custom_api_key: xorEncrypt(API_KEY, deviceId),
                custom_model_name: MODEL,
                table_proxy_address: '',
                table_proxy_key: '',
            });
            pu.muyoo_dataTable = Object.assign({}, pu.muyoo_dataTable || {}, {
                isExtensionAble: true,
                isAiReadTable: true,
                isAiWriteTable: true,
                // 只读注入（表格数据作为参考注入，不要求主模型自己输出表格指令）
                injection_mode: 'deep_system',
                deep: 6,
                // 分步填表：每个 AI 回复后用「备用 API」= 本地 gemma 增量更新表格
                step_by_step: true,
                step_by_step_use_main_api: false,
                bool_silent_refresh: true,
                // 重整理也用本地 gemma
                use_main_api: false,
                custom_temperature: 0.3,
                custom_max_tokens: 1024,
                custom_top_p: 0.9,
                confirm_before_execution: false,
                clear_up_stairs: 6,
                use_token_limit: true,
                rebuild_token_limit_value: 6000,
                separateReadContextLayers: 3,
                separateReadLorebook: false,
                // 表格不要每轮推到聊天界面（保持聊天干净；要看就点开插件面板）
                isTableToChat: false,
                show_drawer_in_extension_list: true,
            });
            pu[CONFIG_TAG] = VERSION;
            // 注意：这里不主动 saveSettings（v1.0.1 起）。
            // 页面加载时多个扩展同时保存设置，容易撞上服务端/CSRF 的瞬间失败，
            // 弹出「Settings could not be saved」；配置只写内存即可，之后 ST 自己的保存会带上它。
            console.log('[dsh-model-config] 已配置记忆插件 + 角色卡更新（本地 gemma4-e4b）');
            return true;
        } catch (e) {
            console.warn('[dsh-model-config] 写记忆插件设置失败', e);
            return false;
        }
    }

    // ---------------------------------------------------------------- 启动 --
    installFetchHook();
    applyAutoCardUpdater();

    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        if (applyMemorySettings() || tries > 80) clearInterval(timer);
    }, 500);

    try {
        const c = ctx();
        c?.eventSource?.on?.(c.eventTypes?.APP_READY, () => {
            setTimeout(applyMemorySettings, 800);
            setTimeout(applyMemorySettings, 2500);
        });
    } catch (e) { /* ignore */ }

    window.__DSH_MODEL_CONFIG = {
        version: VERSION,
        apiUrl: API_URL,
        model: MODEL,
        applyMemorySettings,
        applyAutoCardUpdater,
        /** 手动卸载本地模型，释放内存/显存：POST /api/generate keep_alive:0 */
        unload: async () => {
            try {
                await fetch(OLLAMA_BASE + '/api/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: MODEL, prompt: '', keep_alive: 0 }),
                });
                return true;
            } catch (e) { return false; }
        },
        diag: () => {
            const c = ctx();
            const pu = (c && c.powerUserSettings) || {};
            return {
                version: VERSION,
                applied: pu[CONFIG_TAG] || null,
                memory: pu.muyoo_dataTable || null,
                privacy: pu.IMPORTANT_USER_PRIVACY_DATA ? {
                    custom_api_url: pu.IMPORTANT_USER_PRIVACY_DATA.custom_api_url,
                    custom_model_name: pu.IMPORTANT_USER_PRIVACY_DATA.custom_model_name,
                    hasKey: !!pu.IMPORTANT_USER_PRIVACY_DATA.custom_api_key,
                } : null,
                acu: (() => { try { return JSON.parse(localStorage.getItem('autoCardUpdater_apiConfig_v1') || 'null'); } catch (e) { return null; } })(),
            };
        },
    };

    console.log('[dsh-model-config] v' + VERSION + ' 已加载：本地模型 = ' + MODEL);
})();

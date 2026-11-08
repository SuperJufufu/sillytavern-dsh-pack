/**
 * DSH 生成看门狗 (dsh-gen-guard) v1.1.1
 *
 * 背景：SillyTavern 的"生成中"状态（is_send_press + body[data-generating]）只会在
 * Generate() 的收尾路径里被解除。只要收尾链上任何一步是「永远不 resolve 的 Promise」
 * （扩展事件监听挂住、IndexedDB/存档调用挂住、某个 fetch 卡死……），UI 就会一直锁着，
 * 即使文字和图片都已经显示完毕。
 *
 * 本扩展做两件事：
 *   1. 监控「还锁着 + 没有在跑的流式生成 + 没有正在进行的网络请求」超过 45 秒 → 强制解锁；
 *      有请求但单个请求已经挂了 6 分钟 → 也强制解锁；无论如何锁超过 12 分钟 → 强制解锁。
 *   2. 强制解锁时，把诊断快照写进聊天元数据 chat_metadata.dsh_gen_guard：
 *      卡住期间未结束的 event emit（及该事件的监听器源码）、未结束的 fetch 等。
 *      这样即使浏览器控制台看不到，也能事后从聊天 jsonl 里读到原因。
 *
 * 控制台手动解锁：__DSH_GEN_GUARD.unblock()
 * 删掉本文件夹即可完全移除。
 */
(function () {
    'use strict';

    const IDLE_UNBLOCK_MS = 45000;          // 无流、无网络请求、仍锁着 → 45 秒后强制解锁
    const FETCH_HANG_MS = 5 * 60 * 1000;    // 单个请求挂 5 分钟 → 视为卡死
    const HARD_UNBLOCK_MS = 12 * 60 * 1000; // 兜底：锁超过 12 分钟强制解锁（哪怕请求还挂着）
    const COOLDOWN_MS = 30000;
    const TICK_MS = 3000;
    const RING_MAX = 240;

    let ready = false;
    let st = null;            // /script.js 模块（拿 is_send_press / streamingProcessor 的实时值）
    let busySince = 0;
    let lockedSince = 0;
    let lastUnlockAt = 0;

    /** 记录：{ kind:'emit'|'fetch', name, start, end, args? } */
    const ring = [];
    const liveEmits = new Set();
    const liveFetches = new Set();

    function push(rec) {
        ring.push(rec);
        if (ring.length > RING_MAX) ring.shift();
        return rec;
    }

    function ctx() {
        try {
            return window.SillyTavern?.getContext?.() ?? null;
        } catch (e) {
            return null;
        }
    }

    function isVisible(sel) {
        const el = document.querySelector(sel);
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null;
    }

    function snip(s) {
        return String(s || '').replace(/\s+/g, ' ').slice(0, 240);
    }

    // ---------------------------------------------------------------- 网络跟踪 --
    function wrapFetch() {
        const prev = window.fetch;
        if (typeof prev !== 'function' || prev.__dshGenGuard) return;
        const wrapped = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const rec = push({ kind: 'fetch', name: url, start: Date.now(), end: null });
            liveFetches.add(rec);
            let p;
            try {
                p = prev.apply(this, arguments);
            } catch (e) {
                rec.end = Date.now(); rec.err = String(e); liveFetches.delete(rec);
                throw e;
            }
            return p.then(
                (res) => {
                    rec.end = Date.now(); rec.status = res?.status; liveFetches.delete(rec);
                    return res;
                },
                (err) => {
                    rec.end = Date.now(); rec.err = String((err && err.message) || err); liveFetches.delete(rec);
                    throw err;
                },
            );
        };
        wrapped.__dshGenGuard = true;
        window.fetch = wrapped;
    }

    // ---------------------------------------------------------------- 事件跟踪 --
    function wrapEmitter(c) {
        const es = c?.eventSource;
        if (!es || typeof es.emit !== 'function' || es.emit.__dshGenGuard) return false;
        const prev = es.emit;
        const wrapped = async function (event) {
            const args = Array.prototype.slice.call(arguments, 1);
            const rec = push({ kind: 'emit', name: String(event), start: Date.now(), end: null, args: snip(args[0]) });
            liveEmits.add(rec);
            try {
                return await prev.apply(this, arguments);
            } finally {
                rec.end = Date.now();
                liveEmits.delete(rec);
            }
        };
        wrapped.__dshGenGuard = true;
        es.emit = wrapped;
        return true;
    }

    // ---------------------------------------------------------------- 诊断快照 --
    function listenerInfo(c, eventName) {
        try {
            const list = c?.eventSource?.events?.[eventName] || [];
            return list.slice(0, 30).map((fn) => snip(fn && (fn.__orig || fn)));
        } catch (e) {
            return [];
        }
    }

    function buildDiag(reason) {
        const c = ctx();
        const now = Date.now();
        const hangingEmits = Array.from(liveEmits).map((r) => ({
            event: r.name,
            runningMs: now - r.start,
            args: r.args,
            listeners: listenerInfo(c, r.name),
        }));
        const hangingFetches = Array.from(liveFetches).map((r) => ({ url: r.name, runningMs: now - r.start }));
        return {
            version: '1.1.0',
            at: new Date(now).toISOString(),
            reason,
            url: String(location.href),
            char: c?.name2,
            chatId: c?.chatId,
            isGroup: !!c?.groupId,
            lockedForMs: lockedSince ? now - lockedSince : 0,
            busyForMs: busySince ? now - busySince : 0,
            lockedState: {
                is_send_press: st ? st.is_send_press : 'n/a',
                generating: document.body.dataset.generating || '',
                streamingProcessor: st && st.streamingProcessor ? 'present' : 'null',
            },
            dom: {
                stopVisible: isVisible('#mes_stop'),
                sdStopVisible: isVisible('#sd_stop_gen'),
            },
            hangingEmits,
            hangingFetches,
            lastEvents: ring.slice(-90),
        };
    }

    function persistDiag(diag) {
        const c = ctx();
        if (!c) return false;
        let ok = false;
        try {
            if (typeof c.updateChatMetadata === 'function') {
                c.updateChatMetadata({ dsh_gen_guard: diag });
            } else if (c.chatMetadata) {
                c.chatMetadata.dsh_gen_guard = diag;
            }
            if (typeof c.saveChat === 'function') {
                Promise.resolve(c.saveChat()).catch(() => { /* ignore */ });
            }
            ok = true;
        } catch (e) {
            console.warn('[gen-guard] 写入聊天元数据失败', e);
        }
        // 额外写一份到 settings.json：即使卡住的原因正是"存档/聊天保存"挂死，
        // 这份也能落盘（data/default-user/settings.json 里的 extension_settings['dsh-gen-guard']）。
        try {
            if (c.extensionSettings) {
                c.extensionSettings['dsh-gen-guard'] = { last: diag };
            }
            if (typeof c.saveSettingsDebounced === 'function') {
                c.saveSettingsDebounced();
            }
            ok = true;
        } catch (e) {
            console.warn('[gen-guard] 写入设置诊断失败', e);
        }
        return ok;
    }

    // ---------------------------------------------------------------- 解锁动作 --
    function forceUnblock(reason) {
        const now = Date.now();
        if (now - lastUnlockAt < COOLDOWN_MS) return;
        lastUnlockAt = now;

        const diag = buildDiag(reason);
        const saved = persistDiag(diag);

        const c = ctx();
        try { c?.activateSendButtons?.(); } catch (e) { console.warn('[gen-guard] activateSendButtons 失败', e); }
        try { delete document.body.dataset.generating; } catch (e) { /* ignore */ }
        try { $('#sd_stop_gen').hide(); } catch (e) { /* ignore */ }
        try { $('.sd_message_gen .fa-hourglass').removeClass('fa-hourglass').addClass('fa-paintbrush'); } catch (e) { /* ignore */ }

        lockedSince = 0;
        busySince = 0;

        const msg = '检测到「生成中」状态卡死，已自动解锁。' + (saved ? '（诊断已写入聊天元数据 dsh_gen_guard）' : '');
        try { toastr.warning(msg, '生成看门狗', { timeOut: 8000 }); } catch (e) { /* ignore */ }
        console.warn('[gen-guard] 已强制解锁:', reason, diag);
    }

    // ---------------------------------------------------------------- 主循环 ----
    function tick() {
        if (!ready) {
            const c = ctx();
            if (c && wrapEmitter(c)) {
                wrapFetch();
                import('/script.js').then((m) => {
                    st = m;
                    console.log('[gen-guard] v1.1.0 已启用（is_send_press 可读）');
                }).catch((e) => {
                    console.warn('[gen-guard] 无法读取 /script.js，降级为 DOM 判断', e);
                    st = null;
                    console.log('[gen-guard] v1.1.0 已启用（降级模式）');
                });
                ready = true;
            }
            return;
        }

        const c = ctx();
        if (!c) return;

        const now = Date.now();
        const isSendPress = st ? st.is_send_press === true : false;
        const locked = isSendPress || document.body.dataset.generating === 'true' || isVisible('#mes_stop');

        if (!locked) {
            busySince = 0;
            lockedSince = 0;
            return;
        }

        busySince = busySince || now;

        // 有弹窗在等用户操作（例如存档完整性确认）→ 不算卡死
        if (['#shadow_popup', '#dialogue_popup', '#character_popup', '.popup'].some((sel) => isVisible(sel))) {
            lockedSince = 0;
            return;
        }

        // 流式生成还在跑 = 正常
        const sp = (st && st.streamingProcessor) || c.streamingProcessor;
        if (sp && !sp.isFinished) {
            lockedSince = 0;
            return;
        }

        // 有正在进行的网络请求 = 正常在跑（写词 / 出图 / 存档 / 后台生图）
        if (liveFetches.size > 0) {
            let oldest = now;
            for (const r of liveFetches) oldest = Math.min(oldest, r.start);
            if (now - oldest > FETCH_HANG_MS) {
                forceUnblock('fetch-hang');
                return;
            }
            lockedSince = 0;
            if (now - busySince > HARD_UNBLOCK_MS) forceUnblock('hard-timeout');
            return;
        }

        if (!lockedSince) lockedSince = now;
        if (now - lockedSince >= IDLE_UNBLOCK_MS) {
            forceUnblock('idle-no-network');
            return;
        }
        if (now - busySince > HARD_UNBLOCK_MS) forceUnblock('hard-timeout');
    }

    // 手动工具：控制台可执行 __DSH_GEN_GUARD.unblock() 直接解锁
    window.__DSH_GEN_GUARD = {
        unblock: () => forceUnblock('manual'),
        diag: () => buildDiag('manual-diag'),
        state: () => ({ ready, hasScript: !!st, busySince, lockedSince, liveEmits: liveEmits.size, liveFetches: liveFetches.size }),
        /** 是否正在生图（供 dsh-image-fold 的「重绘」排队用） */
        sdBusy: () => {
            try {
                for (const r of liveFetches) {
                    const n = String((r && r.name) || '');
                    if (n.includes('/api/sd/')) return true;
                }
            } catch (e) { /* ignore */ }
            return false;
        },
        live: () => {
            try { return Array.from(liveFetches).map((r) => String((r && r.name) || '')).slice(0, 20); } catch (e) { return []; }
        },
    };

    setInterval(tick, TICK_MS);
    setTimeout(tick, 1500);
    console.log('[gen-guard] 已加载，等待 APP 就绪…');
})();

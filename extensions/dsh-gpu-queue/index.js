/**
 * DSH 重任务排队 (dsh-gpu-queue) v1.0.0
 *
 * 背景：三个重任务都在抢同一台机器：
 *   1) 聊天配图  SDXL（走 /api/sd/comfy/generate → 桥接 8189 → ComfyUI 8188）
 *   2) 背景图    Qwen-Image（同样走 /api/sd/comfy/generate）
 *   3) 本地 LLM  gemma4-e4b（记忆填表 / 角色卡更新，走 11434 /v1/chat/completions）
 *
 * 做法：拦住 window.fetch，把这三类请求放进同一个「单通道队列」：
 *   · 同一时刻只允许一个重任务在跑，其余排队；
 *   · 优先级：生图/背景图 > gemma（聊天配图优先，gemma 后台任务让路）；
 *   · 小模型（minicpm 抓人名、8030 的 1.5B 场景检测）完全不排队，照常跑。
 *
 * 排队是在浏览器端做的，不影响 ST 服务端逻辑；删掉本文件夹即可恢复并行。
 */
(function () {
    'use strict';

    const VERSION = '1.0.0';

    const IMAGE_GENERATE_RE = /\/api\/sd\/comfy\/generate(?:[?#]|$)/;
    const COMFY_FREE_RE = /:(?:8188|8189)\/free(?:[?#]|$)/;
    const OLLAMA_CHAT_RE = /(?:127\.0\.0\.1|localhost):11434\/(?:v1\/)?chat\/completions/;
    const GEMMA_MODEL_RE = /gemma\s*-?\s*4/i;

    let seq = 0;
    let active = null;
    const queue = [];
    const events = [];
    const RING_MAX = 120;

    function record(ev) {
        events.push(ev);
        if (events.length > RING_MAX) events.shift();
    }

    function bodyModel(init) {
        try {
            if (!init || typeof init.body !== 'string') return '';
            const obj = JSON.parse(init.body);
            return String((obj && obj.model) || '');
        } catch (e) {
            return '';
        }
    }

    /** 判断一个 fetch 属于哪类重任务；返回 null = 不排队 */
    function classify(input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            if (!url) return null;

            if (IMAGE_GENERATE_RE.test(url)) {
                // 生图和 Qwen 背景图都走这个端点（GPU 独占任务）
                return { cat: 'image', label: '生图(SDXL/Qwen)' };
            }
            if (COMFY_FREE_RE.test(url)) {
                // Qwen 背景图出完后会请求 ComfyUI 卸模型；也算重任务，避免把刚加载的 SDXL 卸掉
                return { cat: 'image', label: 'Comfy卸载模型' };
            }
            if (method === 'POST' && OLLAMA_CHAT_RE.test(url)) {
                const model = bodyModel(init);
                if (GEMMA_MODEL_RE.test(model)) {
                    return { cat: 'gemma', label: 'gemma:' + model };
                }
                // 其它 Ollama 小模型（minicpm 等）不排队
                return null;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    function priorityOf(cat) {
        return cat === 'image' ? 2 : 1;
    }

    function abortError() {
        try { return new DOMException('The user aborted a request.', 'AbortError'); }
        catch (e) { const err = new Error('Aborted'); err.name = 'AbortError'; return err; }
    }

    function pump() {
        if (active || queue.length === 0) return;
        // 高优先级先跑；同优先级按入队顺序（id 小的先）
        queue.sort((a, b) => (priorityOf(b.cat) - priorityOf(a.cat)) || (a.id - b.id));
        const task = queue.shift();
        if (task.signal && task.signal.aborted) {
            task.reject(abortError());
            return pump();
        }
        active = task;
        task.startAt = Date.now();
        record({ phase: 'start', cat: task.cat, label: task.label, id: task.id, t: task.startAt });
        Promise.resolve()
            .then(() => task.run())
            .then((value) => {
                task.endAt = Date.now();
                record({ phase: 'end', cat: task.cat, label: task.label, id: task.id, t: task.endAt, ms: task.endAt - task.startAt, ok: true });
                task.resolve(value);
            }, (err) => {
                task.endAt = Date.now();
                record({ phase: 'end', cat: task.cat, label: task.label, id: task.id, t: task.endAt, ms: task.endAt - task.startAt, ok: false, err: String((err && err.message) || err) });
                task.reject(err);
            })
            .finally(() => {
                active = null;
                pump();
            });
    }

    function enqueue(info, run, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(abortError());
            const task = { id: ++seq, cat: info.cat, label: info.label, run, resolve, reject, signal };
            queue.push(task);
            record({ phase: 'queued', cat: task.cat, label: task.label, id: task.id, t: Date.now() });
            if (signal) {
                try {
                    signal.addEventListener('abort', () => {
                        const idx = queue.indexOf(task);
                        if (idx >= 0) {
                            queue.splice(idx, 1);
                            reject(abortError());
                        }
                    }, { once: true });
                } catch (e) { /* ignore */ }
            }
            pump();
        });
    }

    function install() {
        const orig = window.fetch;
        if (typeof orig !== 'function' || orig.__dshGpuQueue) return;
        const wrapped = function (input, init) {
            try {
                const info = classify(input, init);
                if (info) {
                    return enqueue(info, () => orig.call(this, input, init), init && init.signal);
                }
            } catch (e) { /* ignore */ }
            return orig.call(this, input, init);
        };
        wrapped.__dshGpuQueue = true;
        window.fetch = wrapped;
    }

    install();

    window.__DSH_GPU_QUEUE = {
        version: VERSION,
        classify: (url, init) => classify(url, init),
        state: () => ({
            active: active ? { cat: active.cat, label: active.label, ms: Date.now() - active.startAt } : null,
            waiting: queue.map((t) => ({ cat: t.cat, label: t.label, id: t.id })),
            events: events.slice(-20),
        }),
        diag: () => JSON.stringify({ version: VERSION, active: active ? { cat: active.cat, label: active.label, ms: Date.now() - active.startAt } : null, waiting: queue.length, events: events.slice(-30) }),
        /** 测试用：入队一个假任务（kind = 'image' | 'gemma'） */
        test: (kind, ms) => new Promise((resolve, reject) => {
            const cat = kind === 'image' ? 'image' : 'gemma';
            enqueue({ cat, label: 'test:' + cat }, () => new Promise((r) => setTimeout(r, Math.max(50, Number(ms) || 500))), null)
                .then((v) => resolve(v))
                .catch(reject);
        }),
    };

    console.log('[gpu-queue] v' + VERSION + ' 已加载：生图 / 背景图 / gemma 排队执行，小模型不受影响');
})();

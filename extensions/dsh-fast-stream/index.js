/**
 * DSH 流式加速 (dsh-fast-stream) v1.0.0
 *
 * 作用：强制关闭 Smooth Streaming（平滑流式输出）并把 streaming_fps 拉到 100。
 *
 * 为什么：ST 的 Smooth Streaming 会把 SSE 流再包一层 TransformStream，
 * 每收到一个 token 就 `await delay(getDelay(...))` 慢慢播（见 sse-stream.js），
 * 所以模型吐字再快，屏幕上也是匀速慢放；关掉后按 token 真实到达速度出字。
 * streaming_fps 只是渲染刷新上限（Stopwatch 是"跳过"而不是"等待"），不是限速源。
 *
 * 只在页面加载时强制一次；之后如果你在设置里手动打开平滑流式，刷新页面又会被关掉。
 * 删掉本文件夹即可完全恢复由设置面板控制。
 */
(function () {
    'use strict';

    const TARGET_FPS = 100;
    let done = false;

    function ctx() {
        try { return window.SillyTavern?.getContext?.() ?? null; } catch (e) { return null; }
    }

    function apply() {
        if (done) return;
        const c = ctx();
        const pu = c && c.powerUserSettings;
        if (!pu || typeof pu !== 'object') return;
        done = true;

        let changed = false;
        if (pu.smooth_streaming) {
            pu.smooth_streaming = false;
            changed = true;
        }
        if (Number(pu.streaming_fps) < TARGET_FPS) {
            pu.streaming_fps = TARGET_FPS;
            changed = true;
        }

        // 同步 UI 控件（设置面板打开时也显示为已关闭）
        try {
            const el = document.getElementById('smooth_streaming');
            if (el) el.checked = false;
            const fps = document.getElementById('streaming_fps');
            if (fps) fps.value = String(TARGET_FPS);
            const fpsCounter = document.getElementById('streaming_fps_counter');
            if (fpsCounter) fpsCounter.value = String(TARGET_FPS);
        } catch (e) { /* ignore */ }

        if (changed) {
            try { c.saveSettingsDebounced?.(); } catch (e) { /* ignore */ }
            console.log('[fast-stream] 已关闭平滑流式输出，streaming_fps = ' + TARGET_FPS);
        } else {
            console.log('[fast-stream] 平滑流式输出已是关闭状态');
        }
    }

    // 设置是异步加载的，轮询到 powerUserSettings 出现为止
    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        apply();
        if (done || tries > 120) clearInterval(timer);
    }, 500);

    try {
        const c = ctx();
        c?.eventSource?.on?.(c.eventTypes?.APP_READY, () => setTimeout(apply, 300));
    } catch (e) { /* ignore */ }
})();

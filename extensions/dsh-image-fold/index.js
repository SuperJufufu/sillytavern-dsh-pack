/**
 * DSH 图片折叠 (dsh-image-fold) v1.1.3
 *
 * 问题：每轮出图会在聊天里插入一条「只有图片」的消息（extra.image / inline_image=false），
 *       ST 默认按 40vh 高度直接铺在聊天里，连续几张就把对话框占满了。
 *
 * 做法：把这类图片消息折叠成一条小缩略条（缩略图 + 「图片 · 点击查看」+ 重绘 / 删除按钮），
 *       点击缩略条弹出全屏大图；点任意位置（或 Esc）关闭，不改变聊天数据。
 *
 * v1.1.0：小条上加「重绘」「删除」两个按钮。
 *   · 重绘 = 调用 ST 生图扩展对这条消息的原生重绘（同一提示词重新生成，结果成为这张图的新版本，
 *            不新增聊天消息）；v1.1.2 起会先等当前这轮出图结束再排队重绘，失败自动重试一次。
 *   · 删除 = 删除这条图片消息，并把磁盘上的图片文件（当前图 + 全部重绘版本）一起删掉，
 *            不再留下占空间的孤儿文件（v1.1.3 起真删文件；被聊天背景引用的文件会保留）。
 *
 * 只处理「非 inline」的图片消息；文字里内嵌的图片、视频消息不动。删掉本文件夹 = 完全恢复原样。
 */
(function () {
    'use strict';

    const VERSION = '1.1.4';
    const FOLD = 'dsh-imgfold';
    const BAR = 'dsh-imgfold-bar';
    const OVERLAY = 'dsh-imgfold-overlay';
    const STYLE_ID = 'dsh-imgfold-style';

    const CSS = `
.mes.${FOLD} > .mes_block > .mes_img_container { display: none !important; }
/* v1.1.4：生成图（非 inline）的容器在「还没被折叠」的瞬间也先隐藏 ——
   否则每次新消息/重绘时，旧图会先以整张大图露出来，还能被点到 ST 自带的大图弹窗 */
.mes .mes_img_container.img_extra:has(> .mes_img:not(.img_inline)) { display: none !important; }
.mes > .mes_block > .${BAR} {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 2px;
    padding: 4px 8px;
    width: fit-content;
    max-width: 100%;
    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.2));
    border-radius: 8px;
    background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.25));
    color: var(--SmartThemeBodyColor, #e8e8e8);
    cursor: pointer;
    font-size: 12px;
    line-height: 1.2;
    opacity: 0.85;
    user-select: none;
    box-sizing: border-box;
    flex-wrap: wrap;
}
.mes > .mes_block > .${BAR}:hover { opacity: 1; }
.${BAR} .dsh-imgfold-icon { opacity: 0.8; }
.${BAR} .dsh-imgfold-thumb {
    display: block;
    height: 52px;
    width: auto;
    max-width: 110px;
    object-fit: cover;
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.25);
}
.${BAR} .dsh-imgfold-count { opacity: 0.7; font-variant-numeric: tabular-nums; }
.${BAR} .dsh-imgfold-actions { display: flex; align-items: center; gap: 4px; margin-left: 2px; }
.${BAR} .dsh-imgfold-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.25));
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    line-height: 1.3;
    font-family: inherit;
    white-space: nowrap;
}
.${BAR} .dsh-imgfold-btn:hover { background: rgba(255, 255, 255, 0.16); }
.${BAR} .dsh-imgfold-btn:disabled { opacity: 0.55; cursor: default; }
.${BAR} .dsh-imgfold-btn.dsh-imgfold-delete:hover { color: #ff9a9a; border-color: rgba(255, 120, 120, 0.6); }
.${OVERLAY} {
    position: fixed;
    inset: 0;
    z-index: 30000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2vh 2vw;
    background: rgba(0, 0, 0, 0.82);
    cursor: zoom-out;
}
.${OVERLAY} .dsh-imgfold-overlay-img {
    max-width: 94vw;
    max-height: 88vh;
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
}
.${OVERLAY} .dsh-imgfold-overlay-hint {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 12px;
    text-align: center;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.75);
    pointer-events: none;
}
@media (max-width: 640px) {
    .${BAR} .dsh-imgfold-btn .dsh-imgfold-btn-text { display: none; }
    .${BAR} .dsh-imgfold-btn { padding: 4px 7px; }
}
`;

    let observer = null;
    let scheduleTimer = null;
    let overlayEl = null;
    let started = false;

    function ctx() {
        try { return window.SillyTavern?.getContext?.() ?? null; } catch (e) { return null; }
    }

    function chatArr() {
        const c = ctx();
        return c && Array.isArray(c.chat) ? c.chat : [];
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent = CSS;
        (document.head || document.documentElement).appendChild(st);
    }

    /** 这条消息是不是「生成出来的图片」（非 inline 图片消息） */
    function imageOf(mes) {
        if (!mes || !mes.extra) return '';
        if (mes.extra.inline_image) return '';
        if (!mes.extra.image) return '';
        return String(mes.extra.image);
    }

    function msgOfEl(el) {
        const id = Number(el && el.getAttribute && el.getAttribute('mesid'));
        const arr = chatArr();
        return Number.isFinite(id) && id >= 0 ? arr[id] : null;
    }

    function overlayClose() {
        if (overlayEl) {
            try { overlayEl.remove(); } catch (e) { /* ignore */ }
            overlayEl = null;
        }
        try { document.removeEventListener('keydown', onOverlayKey, true); } catch (e) { /* ignore */ }
    }

    function onOverlayKey(e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
            e.preventDefault();
            e.stopPropagation();
            overlayClose();
        }
    }

    /** 全屏看大图：点任意位置 / Esc 关闭 */
    function overlayOpen(src, title) {
        overlayClose();
        if (!src) return;
        const ov = document.createElement('div');
        ov.className = OVERLAY;
        ov.title = title ? String(title).slice(0, 300) : '';
        const img = document.createElement('img');
        img.className = 'dsh-imgfold-overlay-img';
        img.alt = '';
        img.src = src;
        const hint = document.createElement('div');
        hint.className = 'dsh-imgfold-overlay-hint';
        hint.textContent = '点击任意位置关闭（Esc）';
        ov.append(img, hint);
        ov.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            overlayClose();
        });
        document.body.appendChild(ov);
        overlayEl = ov;
        try { document.addEventListener('keydown', onOverlayKey, true); } catch (e) { /* ignore */ }
    }

    function openForElement(el) {
        const mes = msgOfEl(el);
        const src = imageOf(mes);
        if (!src) return;
        overlayOpen(src, mes.extra && mes.extra.title ? mes.extra.title : '');
    }

    function toast(level, msg) {
        try {
            const t = window.toastr;
            if (t && typeof t[level] === 'function') { t[level](String(msg), '图片折叠'); return; }
        } catch (e) { /* ignore */ }
        console.log('[image-fold] ' + msg);
    }

    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    let redrawBusy = false;
    let lastRedrawError = '';
    let lastRedrawAt = 0;

    /** 现在是否有生图请求在跑（依赖 dsh-gen-guard 的网络跟踪；没有就返回 false） */
    function sdBusy() {
        try {
            const g = window.__DSH_GEN_GUARD;
            if (g && typeof g.sdBusy === 'function') return !!g.sdBusy();
        } catch (e) { /* ignore */ }
        return false;
    }

    /** 出图独占 GPU：先等当前这轮图出完再重绘，避免两个生图请求撞在一起报 Failed to fetch */
    async function waitSdIdle(label, timeoutMs) {
        const t0 = Date.now();
        let announced = false;
        while (sdBusy()) {
            if (Date.now() - t0 >= (timeoutMs || 300000)) return false;
            if (!announced) { announced = true; if (label) label.textContent = '等出图中…'; }
            await sleep(800);
        }
        if (announced && label) label.textContent = '重绘中…';
        return true;
    }

    /** 临时截获 ST 自己弹的 toastr 错误（生图失败原因写在那里），方便回显给用户 */
    function captureToasts() {
        const t = window.toastr;
        if (!t || typeof t.error !== 'function' || t.__dshFoldHooked) return () => { };
        const orig = t.error;
        t.__dshFoldHooked = true;
        t.error = function (msg) {
            lastRedrawError = String(msg || '').replace(/\s+/g, ' ').slice(0, 400);
            try { return orig.apply(this, arguments); } catch (e) { return undefined; }
        };
        return () => { try { t.error = orig; } catch (e) { /* ignore */ } delete t.__dshFoldHooked; };
    }

    async function redrawOnce(icon, messageEl, label, before) {
        if (label) label.textContent = '重绘中…';
        icon.click();
        const t0 = Date.now();
        let sawBusy = false;
        let missing = 0;
        await sleep(500);
        while (Date.now() - t0 < 240000) {
            if (icon.classList.contains('fa-hourglass')) {
                sawBusy = true;
                missing = 0;
            } else if (sawBusy) {
                // 忙碌状态掉了：再确认两次，防止图标状态闪一下误判
                if (++missing >= 2) break;
            } else if (Date.now() - t0 > 4000) {
                break; // 一直没进入忙碌 = 生图没启动
            }
            await sleep(600);
        }
        const mes = msgOfEl(messageEl);
        const after = mes && mes.extra ? String(mes.extra.image || '') : '';
        return { sawBusy, after, changed: after !== before };
    }

    /** 重绘：调用 ST 生图扩展对这条消息的原生重绘（同一提示词重新生成，不新增聊天消息） */
    async function redrawMessage(el, btn) {
        const messageEl = (btn && btn.closest && btn.closest('.mes')) || el;
        if (!messageEl) return;
        const icon = messageEl.querySelector('.sd_message_gen');
        if (!icon) {
            toast('warning', '没找到生图扩展的「重绘」按钮：请确认图片生成扩展已开启');
            return;
        }
        if (redrawBusy) {
            toast('info', '上一张还在重绘，等它出完再点');
            return;
        }
        const label = btn ? btn.querySelector('.dsh-imgfold-btn-text') : null;
        const oldLabel = label ? label.textContent : '';
        const mes0 = msgOfEl(messageEl);
        const before = mes0 && mes0.extra ? String(mes0.extra.image || '') : '';
        redrawBusy = true;
        lastRedrawError = '';
        const restoreToast = captureToasts();
        if (btn) btn.disabled = true;
        try {
            // 1) 等当前这轮出图结束：后台「每轮出图」还在跑时，两个生图请求撞一起容易 Failed to fetch
            const idle = await waitSdIdle(label, 300000);
            if (!idle) {
                toast('warning', '当前出图一直没结束，先不重绘；等图出来后再点一次');
                return;
            }
            // 2) 失败自动重试 1 次（生图/网络偶发失败）
            let res = await redrawOnce(icon, messageEl, label, before);
            if (!res.changed) {
                console.warn('[image-fold] 重绘第 1 次没出图，2 秒后重试一次；ST 报错：' + (lastRedrawError || '无'));
                if (label) label.textContent = '重试中…';
                await sleep(2000);
                await waitSdIdle(label, 120000);
                res = await redrawOnce(icon, messageEl, label, before);
            }
            if (res.changed) {
                console.log('[image-fold] 重绘完成 #' + messageEl.getAttribute('mesid'));
            } else if (!res.sawBusy) {
                toast('warning', '重绘没有启动：图片生成扩展可能已关闭');
            } else {
                const reason = lastRedrawError ? '：' + lastRedrawError : '';
                toast('error', '重绘失败' + reason + '（可能是 ComfyUI 没起来 / 同时有别的图在生成，等会儿再点一次）');
            }
        } catch (e) {
            console.warn('[image-fold] 重绘失败', e);
            toast('error', '重绘失败：' + ((e && e.message) || e));
        } finally {
            lastRedrawAt = Date.now();
            redrawBusy = false;
            try { restoreToast(); } catch (e) { /* ignore */ }
            if (btn) btn.disabled = false;
            if (label) label.textContent = oldLabel;
            try { decorate(messageEl); } catch (e) { /* ignore */ }
            setTimeout(() => { try { decorateAll(); } catch (e) { /* ignore */ } }, 400);
        }
    }

    /** 只认 ST 本地 user/images 下的文件（生成的图都存这里）；返回可交给 /api/images/delete 的相对路径 */
    function normFileUrl(u) {
        let s = String(u || '').trim();
        if (!s) return '';
        // 兼容 chat_metadata 里存的 url("...") 形式
        s = s.replace(/^url\(\s*["']?/i, '').replace(/["']?\s*\)\s*$/i, '').trim();
        s = s.replace(/^["']|["']$/g, '');
        s = s.replace(/^https?:\/\/[^/]+/i, '');
        s = s.replace(/^\/+/, '');
        try { s = decodeURI(s); } catch (e) { /* ignore */ }
        if (!/^user\/images\/.+\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(s)) return '';
        return s;
    }

    /** 一条消息上挂的所有本地图片文件：当前图 + 全部重绘版本(image_swipes) + 视频 */
    function collectMessageImageFiles(mes) {
        const e = mes && mes.extra;
        if (!e) return [];
        const out = new Set();
        const add = (v) => { const p = normFileUrl(v); if (p) out.add(p); };
        add(e.image);
        add(e.video);
        if (Array.isArray(e.image_swipes)) for (const v of e.image_swipes) add(v);
        return [...out];
    }

    /** 这张图有没有被别的消息 / 当前聊天的背景引用（有就别删文件，免得聊天背景/别的消息裂图） */
    function fileReferencedElsewhere(file, excludeId) {
        const c = ctx();
        const chat = (c && c.chat) || [];
        for (let i = 0; i < chat.length; i++) {
            if (i === excludeId) continue;
            if (collectMessageImageFiles(chat[i]).includes(file)) return true;
        }
        try {
            const md = c.chatMetadata || {};
            const refs = [];
            if (md.custom_background) refs.push(md.custom_background);
            if (Array.isArray(md.chat_backgrounds)) refs.push(...md.chat_backgrounds);
            for (const r of refs) if (normFileUrl(r) === file) return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    async function deleteImageFile(file) {
        try {
            const c = ctx();
            const headers = c && typeof c.getRequestHeaders === 'function' ? c.getRequestHeaders() : null;
            if (!headers) return false;
            const r = await fetch('/api/images/delete', {
                method: 'POST',
                headers,
                body: JSON.stringify({ path: file }),
            });
            if (r.ok) return true;
            console.warn('[image-fold] 删除图片文件失败 HTTP ' + r.status + '：' + file);
            return false;
        } catch (e) {
            console.warn('[image-fold] 删除图片文件失败：' + file, e);
            return false;
        }
    }

    /** 删除：删掉这条图片消息，并把磁盘上的图片文件（含重绘的旧版本）一起删掉 */
    async function deleteMessage(el, btn) {
        const c = ctx();
        const messageEl = (btn && btn.closest && btn.closest('.mes')) || el;
        const id = Number(messageEl && messageEl.getAttribute('mesid'));
        if (!c || !Array.isArray(c.chat) || !Number.isFinite(id) || id < 0 || !c.chat[id]) return;
        if (btn) btn.disabled = true;
        // 0) 先确定要删哪些磁盘文件（拿 id 排除自己，判断有没有被别处引用）
        const files = collectMessageImageFiles(c.chat[id]);
        const toDelete = [];
        const skipped = [];
        for (const f of files) {
            if (fileReferencedElsewhere(f, id)) skipped.push(f);
            else toDelete.push(f);
        }
        try {
            // 正在编辑这条消息 → 先退出编辑
            try {
                if (messageEl.classList.contains('mes_edit')) {
                    const cancel = messageEl.querySelector('.mes_edit_cancel');
                    if (cancel) cancel.click();
                }
            } catch (e) { /* ignore */ }
            c.chat.splice(id, 1);
            messageEl.remove();
            // 和 ST 的 updateViewMessageIds 一致：重排 mesid / 最后一条标记 / 编号显示
            const startFromZero = id === 0;
            const firstEl = document.querySelector('#chat .mes');
            const minId = startFromZero ? 0 : (firstEl ? (Number(firstEl.getAttribute('mesid')) || 0) : 0);
            const mesEls = document.querySelectorAll('#chat .mes');
            mesEls.forEach((m, i) => {
                m.setAttribute('mesid', String(minId + i));
                const d = m.querySelector('.mesIDDisplay');
                if (d) d.textContent = '#' + (minId + i);
            });
            mesEls.forEach((m) => m.classList.remove('last_mes'));
            if (mesEls.length) mesEls[mesEls.length - 1].classList.add('last_mes');
            try { if (c.chatMetadata) c.chatMetadata.tainted = true; } catch (e) { /* ignore */ }
            try { await c.eventSource.emit(c.eventTypes.MESSAGE_DELETED, c.chat.length); } catch (e) { /* ignore */ }
            try { await c.saveChat(); } catch (e) { toast('warning', '聊天保存失败：请手动保存一次'); }
            setTimeout(decorateAll, 200);
            console.log('[image-fold] 已删除图片消息 #' + id + '，磁盘文件 ' + files.length + ' 个（跳过引用 ' + skipped.length + '）');

            // 1) 再删磁盘文件（消息已经从聊天里消失，删文件慢一点不影响操作）
            let okCount = 0;
            let failCount = 0;
            for (const f of toDelete) {
                if (await deleteImageFile(f)) okCount++;
                else failCount++;
            }
            if (okCount) toast('success', '已删除图片消息（磁盘图片 ' + okCount + ' 张）');
            if (skipped.length) toast('warning', '有 ' + skipped.length + ' 张图被当前聊天背景引用，文件保留未删（消息已删除）');
            if (failCount) toast('warning', '有 ' + failCount + ' 张图片文件删除失败（可能已经被手动删掉了）');
        } catch (e) {
            console.warn('[image-fold] 删除失败', e);
            toast('error', '删除失败：' + ((e && e.message) || e));
            if (btn) btn.disabled = false;
        }
    }

    function makeActionButton(cls, title, iconCls, text) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dsh-imgfold-btn ' + cls;
        b.title = title;
        const i = document.createElement('i');
        i.className = 'fa-solid ' + iconCls;
        const sp = document.createElement('span');
        sp.className = 'dsh-imgfold-btn-text';
        sp.textContent = text;
        b.append(i, sp);
        b.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') ev.stopPropagation();
        });
        return b;
    }

    function makeBar(el) {
        const bar = document.createElement('div');
        bar.className = BAR;
        bar.setAttribute('role', 'button');
        bar.tabIndex = 0;

        const icon = document.createElement('span');
        icon.className = 'dsh-imgfold-icon fa-solid fa-image';

        const thumb = document.createElement('img');
        thumb.className = 'dsh-imgfold-thumb';
        thumb.alt = '';
        thumb.onerror = () => { thumb.style.display = 'none'; };

        const label = document.createElement('span');
        label.className = 'dsh-imgfold-label';
        label.textContent = '图片 · 点击查看';

        const count = document.createElement('span');
        count.className = 'dsh-imgfold-count';

        const actions = document.createElement('div');
        actions.className = 'dsh-imgfold-actions';

        const redraw = makeActionButton('dsh-imgfold-redraw', '重绘：用同一提示词重新生成这张图（作为这张图的新版本）', 'fa-rotate-right', '重绘');
        redraw.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            redrawMessage((redraw.closest && redraw.closest('.mes')) || el, redraw);
        });

        const del = makeActionButton('dsh-imgfold-delete', '删除这条图片消息（连磁盘上的图片文件一起删，不弹确认）', 'fa-trash-can', '删除');
        del.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            deleteMessage((del.closest && del.closest('.mes')) || el, del);
        });

        actions.append(redraw, del);
        bar.append(icon, thumb, label, count, actions);
        bar.addEventListener('click', (ev) => {
            if (ev.target && ev.target.closest && ev.target.closest('.dsh-imgfold-actions')) return;
            ev.preventDefault();
            ev.stopPropagation();
            openForElement((bar.closest && bar.closest('.mes')) || el);
        });
        bar.addEventListener('keydown', (ev) => {
            if (ev.target !== bar) return;
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                openForElement((bar.closest && bar.closest('.mes')) || el);
            }
        });
        return bar;
    }

    function updateBar(bar, mes, src) {
        const thumb = bar.querySelector('.dsh-imgfold-thumb');
        if (thumb) {
            if (thumb.getAttribute('src') !== src) {
                thumb.style.display = '';
                thumb.setAttribute('src', src);
            }
        }
        const count = bar.querySelector('.dsh-imgfold-count');
        const swipes = Array.isArray(mes && mes.extra && mes.extra.image_swipes) ? mes.extra.image_swipes : [];
        if (count) {
            const idx = swipes.indexOf(src);
            count.textContent = swipes.length > 1 ? ((idx >= 0 ? idx : 0) + 1) + '/' + swipes.length : '';
        }
        const title = mes && mes.extra && mes.extra.title ? String(mes.extra.title) : '';
        bar.title = title ? title.slice(0, 300) : '点击查看图片';
    }

    function decorate(el) {
        if (!el || !el.classList || !el.classList.contains('mes')) return;
        const mes = msgOfEl(el);
        const src = imageOf(mes);
        const globalBar = el.querySelector('.' + BAR);
        if (!src) {
            // 图片已被删掉 / 换成 inline → 恢复原样
            if (el.classList.contains(FOLD)) el.classList.remove(FOLD);
            if (globalBar) globalBar.remove();
            delete el.dataset.dshImgfold;
            return;
        }
        el.classList.add(FOLD);
        el.dataset.dshImgfold = '1';
        let bar = el.querySelector(':scope > .mes_block > .' + BAR) || globalBar;
        if (!bar) {
            bar = makeBar(el);
            const block = el.querySelector(':scope > .mes_block');
            const imgBox = el.querySelector(':scope > .mes_block > .mes_img_container');
            if (block && imgBox && imgBox.parentElement === block) block.insertBefore(bar, imgBox);
            else if (block) block.appendChild(bar);
            else el.appendChild(bar);
        }
        updateBar(bar, mes, src);
    }

    function decorateAll() {
        try {
            document.querySelectorAll('#chat .mes').forEach(decorate);
        } catch (e) { /* ignore */ }
    }

    function schedule() {
        if (scheduleTimer) clearTimeout(scheduleTimer);
        scheduleTimer = setTimeout(() => {
            scheduleTimer = null;
            decorateAll();
        }, 80);
    }

    function bindEvents() {
        try {
            const c = ctx();
            const es = c && c.eventSource;
            const et = c && c.eventTypes;
            if (!es || typeof es.on !== 'function') return;
            const fire = () => {
                schedule();
                setTimeout(decorateAll, 150);
                setTimeout(decorateAll, 600);
            };
            const names = [
                'CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'CHARACTER_MESSAGE_RENDERED',
                'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED',
                'MESSAGE_EDITED', 'MORE_MESSAGES_LOADED', 'IMAGE_SWIPED', 'IMAGE_DELETED',
            ];
            for (const n of names) {
                const ev = et && et[n];
                if (!ev) continue;
                try { es.on(ev, fire); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    }

    function start() {
        if (started) return;
        started = true;
        injectStyle();
        decorateAll();
        try {
            const chat = document.getElementById('chat');
            if (chat && window.MutationObserver) {
                observer = new MutationObserver(schedule);
                observer.observe(chat, { childList: true, subtree: true });
            }
        } catch (e) { /* ignore */ }
        bindEvents();
        // 兜底：图片被删/被 swipe 时 DOM 结构不一定会触发上面的事件，低频全量扫一遍
        setInterval(() => {
            if (document.getElementById('chat')) decorateAll();
        }, 3000);
        console.log('[image-fold] v' + VERSION + ' 已加载：生成的图片折叠为小条，点击看大图');
    }

    // 等聊天区域和上下文就绪
    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        if (document.getElementById('chat') && ctx()) {
            clearInterval(timer);
            start();
        } else if (tries > 240) {
            clearInterval(timer);
        }
    }, 250);

    // 手动调试接口
    window.__DSH_IMAGE_FOLD = {
        version: VERSION,
        decorateAll,
        foldCount: () => document.querySelectorAll('.mes.' + FOLD).length,
        open: (id) => {
            const el = document.querySelector('#chat .mes[mesid="' + id + '"]');
            if (el) openForElement(el);
        },
        close: overlayClose,
        redraw: (id) => {
            const el = document.querySelector('#chat .mes[mesid="' + id + '"]');
            const btn = el && el.querySelector('.dsh-imgfold-redraw');
            if (btn) { btn.click(); return true; }
            return false;
        },
        remove: (id) => {
            const el = document.querySelector('#chat .mes[mesid="' + id + '"]');
            const btn = el && el.querySelector('.dsh-imgfold-delete');
            if (btn) { btn.click(); return true; }
            return false;
        },
        diag: () => ({
            version: VERSION,
            redrawBusy,
            sdBusy: sdBusy(),
            lastRedrawError,
            lastRedrawAt,
            live: (() => { try { return window.__DSH_GEN_GUARD?.live?.() || []; } catch (e) { return []; } })(),
        }),
    };
})();

/**
 * 界面精简 (ui-simplify) v2.4.0
 *   1) 打开 ST 时自动展开右侧「角色管理」面板
 *   2) 欢迎页「Recent Chats」上方显示一行中文使用提示
 *   3) 移除欢迎语里 ST 自带的那句英文 Hint
 *   4) 聊天/首页内容区宽度：默认 95vw（比 ST 默认的 90vw 左右各再让出 2.5vw），右侧面板展开时 76vw
 *
 * 同时新增常驻「对话列表」按钮，一点回到角色/聊天列表。完全无损：删掉 extensions/ui-simplify 文件夹即可还原。
 */
(function () {
    'use strict';

    const HINT_TEXT = '💡 开新会话点下方【新建聊天】｜ 换角色点右上角【角色管理】｜ 设置点 ⚙';
    // v2.4.0：聊天/首页内容区再宽一点（左右边界各往外挪 2.5vw）
    const CHAT_BASE_WIDTH = '95vw';
    const CHAT_WIDE_WIDTH = '76vw';

    let panelDone = false;
    let hintDone = false;
    let baseWidthDone = false;
    let tries = 0;

    /** 把 ST 的聊天/首页内容区加宽（只做一次；右侧面板展开状态下不干预） */
    function applyChatWidth() {
        if (baseWidthDone) return;
        try {
            if (document.body.classList.contains('dsh-right-wide')) return;
            document.documentElement.style.setProperty('--sheldWidth', CHAT_BASE_WIDTH);
            // 同步 ST 自己的 Chat Width 设置，免得设置面板里显示 90 而实际是 95
            const c = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
            if (c && c.powerUserSettings) c.powerUserSettings.chat_width = Number(String(CHAT_BASE_WIDTH).replace('vw', '')) || 95;
            const slider = document.getElementById('chat_width_slider');
            if (slider) slider.value = String(Number(String(CHAT_BASE_WIDTH).replace('vw', '')) || 95);
            const counter = document.getElementById('chat_width_slider_counter');
            if (counter) counter.value = String(Number(String(CHAT_BASE_WIDTH).replace('vw', '')) || 95);
            baseWidthDone = true;
            console.log('[ui-simplify] 聊天区宽度 → ' + CHAT_BASE_WIDTH);
        } catch (e) { /* ignore */ }
    }

    function openCharPanel() {
        if (panelDone) return;
        if (window.matchMedia && window.matchMedia('(max-width: 1000px)').matches) {
            panelDone = true;
            return;
        }
        const panel = document.querySelector('#right-nav-panel');
        if (!panel) return;
        if (!panel.classList.contains('closedDrawer')) {
            panelDone = true;
            return;
        }
        const icon = document.querySelector('#rightNavDrawerIcon');
        if (!icon) return;
        icon.click();
        panelDone = true;
    }

    function injectHint() {
        if (hintDone) return;
        if (document.getElementById('dsh-hint')) {
            hintDone = true;
            return;
        }
        const header = document.querySelector('.welcomeHeader');
        if (!header) return;
        const el = document.createElement('div');
        el.id = 'dsh-hint';
        el.textContent = HINT_TEXT;
        el.style.cssText = 'font-size:13px;line-height:1.7;color:#9aa4b8;padding:4px 0 8px;width:100%;';
        const title = header.querySelector('.recentChatsTitle');
        if (title) header.insertBefore(el, title);
        else header.prepend(el);
        hintDone = true;
    }

    function removeEnglishHint() {
        const ps = document.querySelectorAll('#chat .mes_text p');
        for (const p of ps) {
            const t = (p.textContent || '').trim();
            if (t.startsWith('Hint: Set any character') || t.includes('welcome page assistant from their')) {
                p.remove();
                return true;
            }
        }
        return false;
    }

    /** 左侧竖排图标按钮（常显，放在聊天区外的空白里，不遮挡对话） */
    function injectListButton() {
        if (document.getElementById('dsh-topbtns')) return;

        const wrap = document.createElement('div');
        wrap.id = 'dsh-topbtns';
        wrap.style.cssText = [
            'position:fixed', 'top:44px', 'left:8px', 'z-index:5000',
            'display:flex', 'flex-direction:column', 'align-items:center',
            'gap:8px',
        ].join(';');

        const pill = (id, icon, title) => {
            const el = document.createElement('div');
            el.id = id;
            el.className = 'menu_button interactable';
            el.innerHTML = `<i class="fa-solid ${icon}"></i>`;
            el.title = title;
            el.style.cssText = [
                'display:flex', 'align-items:center', 'justify-content:center',
                'width:40px', 'height:40px', 'border-radius:10px', 'font-size:15px',
                'background:rgba(0,0,0,.55)', 'color:#dcdcdc',
                'border:1px solid rgba(255,255,255,.18)', 'cursor:pointer',
                'opacity:.92',
            ].join(';');
            el.addEventListener('mouseenter', () => { el.style.opacity = '1'; });
            el.addEventListener('mouseleave', () => { el.style.opacity = '.92'; });
            return el;
        };

        const getCtx = () => window.SillyTavern.getContext();

        // ① 对话列表：打开右上角「角色管理」并切到列表
        const btnList = pill('dsh-list-btn', 'fa-address-card', '对话列表（角色/群）');
        btnList.addEventListener('click', () => {
            const panel = document.querySelector('#right-nav-panel');
            if (!panel || panel.classList.contains('closedDrawer')) {
                document.querySelector('#rightNavDrawerIcon')?.click();
            }
            setTimeout(() => {
                const block = document.querySelector('#rm_print_characters_block');
                if (!block || block.offsetParent === null) {
                    document.querySelector('#rm_button_characters')?.click();
                }
            }, 450);
        });

        // ② 回到首页：关闭当前聊天 → ST 自动显示欢迎页（最近聊天历史）
        const btnHome = pill('dsh-home-btn', 'fa-house', '回到首页（最近聊天记录）');
        btnHome.addEventListener('click', () => {
            const stop = document.getElementById('mes_stop');
            if (stop && !stop.classList.contains('displayNone')) {
                stop.click();          // 正在生成时先停下，否则 ST 不让关聊天
                setTimeout(closeChat, 700);
            } else {
                closeChat();
            }
            function closeChat() {
                const el = document.getElementById('option_close_chat');
                if (el) el.click();
                else console.warn('[ui-simplify] 找不到 option_close_chat');
            }
        });

        // ③ 重命名对话：弹输入框 → ST 原生 renameChat
        const btnRename = pill('dsh-rename-btn', 'fa-pen', '重命名当前对话');
        btnRename.addEventListener('click', async () => {
            try {
                const c = getCtx();
                const oldId = c.chatId;
                if (!oldId) { window.toastr?.info('当前没有打开的对话'); return; }
                const name = window.prompt('新的对话名字：', String(oldId));
                if (name === null) return;
                const next = String(name).trim();
                if (!next || next === oldId) return;
                await c.renameChat(oldId, next);
                window.toastr?.success('已重命名为「' + next + '」');
            } catch (e) {
                console.warn('[ui-simplify] 重命名失败', e);
            }
        });

        // ④ 重新生成背景：调 qwen-bg 的「立即生成背景」
        const btnBg = pill('dsh-rebg-btn', 'fa-image', '重新生成背景（Qwen）');
        btnBg.addEventListener('click', () => {
            const now = document.getElementById('qwenbg-now');
            if (now) {
                now.click();
                window.toastr?.info('正在用 Qwen 重新生成背景…');
            } else {
                window.toastr?.warning('背景扩展(qwen-bg)没加载');
            }
        });

        // ⑤ 生成图片：对最后一条消息触发 ST 的 /imagine
        const btnImg = pill('dsh-img-btn', 'fa-paintbrush', '生成图片（SDXL）');
        btnImg.addEventListener('click', async () => {
            try {
                const c = getCtx();
                if (!c.chatId) { window.toastr?.info('当前没有打开的对话'); return; }
                window.toastr?.info('正在生成图片…');
                await c.executeSlashCommandsWithOptions('/imagine last');
            } catch (e) {
                console.warn('[ui-simplify] 生成图片失败', e);
                window.toastr?.error('生成图片失败：' + (e.message || e));
            }
        });

        wrap.appendChild(btnList);
        wrap.appendChild(btnHome);
        wrap.appendChild(btnRename);
        wrap.appendChild(btnBg);
        wrap.appendChild(btnImg);
        document.body.appendChild(wrap);

        // ⑥ 右侧展开按钮：点一下 → 聊天区左边缘不动（和 95vw 居中时的左边缘一致），只向右收窄
        const BASE_WIDTH = CHAT_BASE_WIDTH;
        const WIDE_WIDTH = CHAT_WIDE_WIDTH;
        // 左边缘 = 95vw 居中时的左边距 = (100-95)/2 = 2.5vw，按按钮时左边不跑位
        const LEFT_GAP = '2.5vw';
        const WIDE_CLASS = 'dsh-right-wide';

        // 宽面板时的布局：聊天贴左、面板在右侧铺开（ST 没有偏移设置，这里用 CSS 覆盖）
        if (!document.getElementById('dsh-right-wide-style')) {
            const st = document.createElement('style');
            st.id = 'dsh-right-wide-style';
            st.textContent = `
body.${WIDE_CLASS} #sheld {
    left: ${LEFT_GAP} !important;
    right: auto !important;
    margin: 0 !important;
}
body.${WIDE_CLASS} .fillRight,
body.${WIDE_CLASS} .fillRight.openDrawer {
    right: 0 !important;
    left: auto !important;
    width: calc(100vw - ${LEFT_GAP} - ${WIDE_WIDTH}) !important;
    min-width: 200px !important;
}
`;
            document.head.appendChild(st);
        }

        function setWide(on) {
            document.body.classList.toggle(WIDE_CLASS, on);
            document.documentElement.style.setProperty('--sheldWidth', on ? WIDE_WIDTH : BASE_WIDTH);
        }

        if (!document.getElementById('dsh-right-expand')) {
            const btnRight = document.createElement('div');
            btnRight.id = 'dsh-right-expand';
            btnRight.className = 'menu_button interactable';
            btnRight.innerHTML = '<i class="fa-solid fa-angles-left"></i>';
            btnRight.title = '展开 / 收起右侧面板（聊天区让出空间）';
            btnRight.style.cssText = [
                'position:fixed', 'top:44px', 'right:8px', 'z-index:5000',
                'display:flex', 'align-items:center', 'justify-content:center',
                'width:40px', 'height:40px', 'border-radius:10px', 'font-size:15px',
                'background:rgba(0,0,0,.55)', 'color:#dcdcdc',
                'border:1px solid rgba(255,255,255,.18)', 'cursor:pointer',
                'opacity:.92',
            ].join(';');
            btnRight.addEventListener('mouseenter', () => { btnRight.style.opacity = '1'; });
            btnRight.addEventListener('mouseleave', () => { btnRight.style.opacity = '.92'; });
            btnRight.addEventListener('click', () => {
                const panel = document.querySelector('#right-nav-panel');
                const icon = document.querySelector('#rightNavDrawerIcon');
                const wide = document.body.classList.contains(WIDE_CLASS);
                if (wide) {
                    // 宽面板 → 收回，聊天恢复宽度
                    setWide(false);
                    if (panel && !panel.classList.contains('closedDrawer')) icon?.click();
                } else {
                    // 细窄状态（或已关闭）→ 让出大空间并拉开面板
                    setWide(true);
                    if (!panel || panel.classList.contains('closedDrawer')) {
                        icon?.click();
                        setTimeout(() => {
                            const block = document.querySelector('#rm_print_characters_block');
                            if (!block || block.offsetParent === null) document.querySelector('#rm_button_characters')?.click();
                        }, 450);
                    }
                }
                setTimeout(updateRightButtonIcon, 400);
            });
            document.body.appendChild(btnRight);
            updateRightButtonIcon();
        }

        function updateRightButtonIcon() {
            const el = document.getElementById('dsh-right-expand');
            if (!el) return;
            const wide = document.body.classList.contains(WIDE_CLASS);
            el.innerHTML = wide ? '<i class="fa-solid fa-angles-right"></i>' : '<i class="fa-solid fa-angles-left"></i>';
            el.title = wide ? '收起右侧面板（聊天区恢复宽度）' : '展开右侧面板（聊天区让出大空间）';
            // 宽模式下如果面板被别的方式关掉，自动恢复聊天宽度
            if (wide) {
                const panel = document.querySelector('#right-nav-panel');
                if (panel && panel.classList.contains('closedDrawer')) setWide(false);
            }
        }
        setInterval(updateRightButtonIcon, 1500);
    }

    /** 防自动跳底：正在往上读的时候，新消息/出图/表格更新都不许把视图拽下去 */
    function installScrollLock() {
        const chatEl = document.getElementById('chat');
        if (!chatEl || chatEl.__dshScrollLocked) return;
        chatEl.__dshScrollLocked = true;

        let saved = chatEl.scrollTop;
        let atBottom = (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight) < 80;
        let restoring = false;

        const nearBottom = () => (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight) < 80;

        chatEl.addEventListener('scroll', () => {
            if (restoring) return;
            const pos = chatEl.scrollTop;
            const jump = Math.abs(pos - saved);
            // 程序滚动（一次跳很远）不当作"用户阅读位置"，直接还原
            if (jump > 250 && !atBottom) {
                restoring = true;
                chatEl.scrollTop = saved;
                setTimeout(() => { restoring = false; }, 120);
                return;
            }
            saved = pos;
            atBottom = nearBottom();
        }, { passive: true });

        const keepPosition = () => {
            if (atBottom) return;
            if (Math.abs(chatEl.scrollTop - saved) > 4) {
                restoring = true;
                chatEl.scrollTop = saved;
                setTimeout(() => { restoring = false; }, 80);
            }
        };

        // DOM 变化（新消息、图片、表格更新、流式文本）后，若用户在读上文就守住位置
        const observer = new MutationObserver(() => {
            if (atBottom) {
                // 本来就在底部 → 跟随新内容；用户在读上文时绝不打扰
                requestAnimationFrame(() => {
                    if (atBottom) {
                        chatEl.scrollTop = chatEl.scrollHeight;
                        saved = chatEl.scrollTop;
                    }
                });
                return;
            }
            keepPosition();
            requestAnimationFrame(keepPosition);
            setTimeout(keepPosition, 80);
            setTimeout(keepPosition, 300);
        });
        observer.observe(chatEl, { childList: true, subtree: true, characterData: true });

        // 新消息事件也补一层
        try {
            const c = window.SillyTavern.getContext();
            const caretaker = () => { if (!atBottom) { keepPosition(); setTimeout(keepPosition, 120); setTimeout(keepPosition, 400); } };
            c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, caretaker);
            c.eventSource.on(c.eventTypes.CHARACTER_MESSAGE_RENDERED, caretaker);
            c.eventSource.on(c.eventTypes.USER_MESSAGE_RENDERED, caretaker);
        } catch (e) { /* ignore */ }
        console.log('[ui-simplify] 防跳底已启用');
    }

    /** 不在对话里（首页/欢迎页）时，隐藏只对当前对话有意义的按钮 */
    function updateChatOnlyButtons() {
        let inChat = false;
        try {
            const c = window.SillyTavern.getContext();
            const welcome = !!document.querySelector('.welcomePanel');
            inChat = !welcome && (!!c.chatId || !!c.groupId);
            // 兜底：角色聊天时 chatId 由 characters[chid].chat 提供，可能为空
            if (!inChat && !welcome && String(c.name2 || '').trim() && !document.getElementById('char_name')?.classList?.contains('displayNone')) {
                // 没有 chatId 但已经选了角色 → 仍视为在对话中（新聊天）
                inChat = !!c.characters?.length && String(c.name2 || '').trim() !== '';
            }
        } catch (e) { /* ignore */ }
        for (const id of ['dsh-rename-btn', 'dsh-rebg-btn', 'dsh-img-btn']) {
            const el = document.getElementById(id);
            if (el) el.style.display = inChat ? 'flex' : 'none';
        }
    }

    function startChatOnlyButtonWatcher() {
        updateChatOnlyButtons();
        setInterval(updateChatOnlyButtons, 2000);
        try {
            const c = window.SillyTavern.getContext();
            c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => setTimeout(updateChatOnlyButtons, 500));
        } catch (e) { /* ignore */ }
    }

    function tick() {
        tries++;
        try {
            openCharPanel();
            injectHint();
            removeEnglishHint();
            injectListButton();
            applyChatWidth();
            installScrollLock();
            updateChatOnlyButtons();
        } catch (e) {
            console.warn('[ui-simplify]', e);
        }
        if (tries >= 12 || (panelDone && hintDone && document.getElementById('dsh-topbtns'))) clearInterval(timer);
    }

    const timer = setInterval(tick, 1200);
    jQuery(async () => {
        await new Promise((r) => setTimeout(r, 4000));
        startChatOnlyButtonWatcher();
    });
})();

import { extension_settings, getContext } from '../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced, Generate } from '../../../../script.js';
import { ensureImageFormatSupported, getBase64Async, getFileExtension, saveBase64AsFile } from '../../../utils.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../../constants.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';

const MODULE = 'dsh-vision-bridge';
const DEFAULTS = {
    enabled: true,
    model: 'deepseek-flash',
    prompt: '你是图像描述器。用中文描述这张图：头部、发型、面部、姿态、手臂与躯干、衣着、场景、光线、构图与镜头；若是线稿或草图，说明线条与明暗。不要数人数，不要推测人物关系或画外内容；看不清就写看不清。3-5 句，只写看见的内容。',
    maxTokens: 420,
    autoInject: false,
};

function S() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (extension_settings[MODULE][k] === undefined) extension_settings[MODULE][k] = v;
    }
    return extension_settings[MODULE];
}

function toast(msg, type = 'info') {
    if (globalThis.toastr) globalThis.toastr[type](msg);
    else console.log('[vision-bridge]', msg);
}

async function urlToDataUrl(url) {
    const abs = new URL(url, location.origin).href;
    const r = await fetch(abs, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('图片读取失败 ' + r.status);
    const blob = await r.blob();
    return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
    });
}

async function describeOne(media, hint = '') {
    let prompt = S().prompt;
    if (hint) prompt += '\n用户说明：' + hint + '（请以此为准，不要添加画面里没有的人或物）';
    const dataUrl = await urlToDataUrl(media.url);
    const body = {
        chat_completion_source: 'deepseek',
        model: S().model,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
            ],
        }],
        max_tokens: Number(S().maxTokens) || 320,
        temperature: 0.2,
        include_reasoning: false,
    };
    const r = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('视觉接口 ' + r.status + ' ' + (await r.text()).slice(0, 160));
    const json = await r.json();
    const msg = json?.choices?.[0]?.message || {};
    return String(msg.content || msg.reasoning_content || '').trim();
}

globalThis.DSH_Vision_Bridge_Interceptor = async function (chat) {
    const s = S();
    if (!s.enabled || !s.autoInject || !Array.isArray(chat)) return;
    const lastUser = [...chat].reverse().find(m => m && m.is_user && !m.is_system);
    if (!lastUser) return;
    const media = Array.isArray(lastUser.extra?.media)
        ? lastUser.extra.media.filter(m => m && String(m.type || '').startsWith('image'))
        : [];
    if (!media.length) return;
    const key = media.map(m => m.url).join('|');
    if (lastUser.extra?.dsh_vision_key === key) return;
    try {
        toast('👁 视觉模型读图中…');
        const parts = [];
        for (const m of media.slice(0, 4)) {
            const d = await describeOne(m);
            if (d) parts.push(d);
        }
        if (parts.length) {
            lastUser.mes = String(lastUser.mes || '') + '\n\n[图片内容：' + parts.join(' / ') + ']';
            lastUser.extra = lastUser.extra || {};
            lastUser.extra.dsh_vision_key = key;
            // 描述已经给文本模型了，别再把原图塞进 prompt（文本模型不支持图片会 400）。
            if (parts.length) {
                lastUser.extra.media = [];
                lastUser.extra.inline_image = false;
            }
            toast(parts.length ? '✅ 已把图片描述交给文本模型' : '⚠️ 视觉模型没有返回描述，保留原图', parts.length ? 'success' : 'warning');
        }
    } catch (e) {
        console.warn('[vision-bridge]', e);
        toast('视觉读图失败：' + e.message, 'error');
    }
};

function mountSettings() {
    const host = document.getElementById('extensions_settings2');
    if (!host) return;
    const s = S();
    const div = document.createElement('div');
    div.className = 'extension_container';
    div.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>视觉读图</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="dsh-vision-enabled" ${s.enabled ? 'checked' : ''}><span>发送图片时先让视觉模型描述</span></label>
                <div class="dsh-vision-row"><span>视觉模型</span><input id="dsh-vision-model" class="text_pole" style="flex:1" value="${s.model}"></div>
                <label class="checkbox_label"><input type="checkbox" id="dsh-vision-autoinject" ${s.autoInject ? 'checked' : ''}><span>原生发图时自动把描述写进消息（不推荐，可能误导读模型）</span></label>
                <div class="dsh-vision-hint">用输入框左侧的图片按钮发图：发送前可以修改识图描述，确认后再发。</div>
            </div>
        </div>`;
    host.append(div);
    div.querySelector('#dsh-vision-enabled').addEventListener('change', e => { s.enabled = e.target.checked; saveSettingsDebounced(); });
    div.querySelector('#dsh-vision-model').addEventListener('change', e => { s.model = e.target.value.trim() || DEFAULTS.model; saveSettingsDebounced(); });
    div.querySelector('#dsh-vision-autoinject').addEventListener('change', e => { s.autoInject = e.target.checked; saveSettingsDebounced(); });
}

function addImageButton() {
    if (document.getElementById('dsh-attach-image')) return;
    const form = document.getElementById('send_form');
    if (!form) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.hidden = true;
    input.id = 'dsh-attach-image-input';
    const btn = document.createElement('div');
    btn.id = 'dsh-attach-image';
    btn.className = 'fa-solid fa-image';
    btn.title = '发送图片（可多选；发送前可编辑识图描述）';
    btn.style.cssText = 'cursor:pointer;font-size:20px;padding:0 10px;align-self:center;opacity:.85;';
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        const files = [...(input.files || [])];
        input.value = '';
        if (files.length) openPreview(files).catch(e => { console.warn('[vision-bridge] preview', e); toast('发图失败：' + e.message, 'error'); });
    });
    const host = document.getElementById('leftSendForm') || form;
    host.appendChild(btn);
    form.appendChild(input);
}

function closePreview() {
    document.getElementById('dsh-vision-overlay')?.remove();
}

async function openPreview(files) {
    closePreview();
    const ctx = getContext();
    const ta = document.getElementById('send_textarea');
    const baseText = String(ta?.value || '').trim();
    const overlay = document.createElement('div');
    overlay.id = 'dsh-vision-overlay';
    overlay.innerHTML = `
        <div class="dsh-vision-modal">
            <div class="dsh-vision-head">发送图片 <span class="dsh-vision-count"></span></div>
            <div class="dsh-vision-thumbs"></div>
            <textarea id="dsh-vision-text" class="text_pole" rows="6"></textarea>
            <div class="dsh-vision-status">识别中…</div>
            <div class="dsh-vision-actions">
                <button id="dsh-vision-cancel" class="menu_button">取消</button>
                <button id="dsh-vision-send" class="menu_button" disabled>发送</button>
            </div>
        </div>`;
    document.body.append(overlay);
    const textEl = overlay.querySelector('#dsh-vision-text');
    const statusEl = overlay.querySelector('.dsh-vision-status');
    const sendBtn = overlay.querySelector('#dsh-vision-send');
    const thumbs = overlay.querySelector('.dsh-vision-thumbs');
    overlay.querySelector('.dsh-vision-count').textContent = files.length > 1 ? `${files.length} 张` : '';
    textEl.value = baseText;
    textEl.addEventListener('input', () => { sendBtn.disabled = !textEl.value.trim() && !saved.length; });
    overlay.querySelector('#dsh-vision-cancel').addEventListener('click', closePreview);

    const saved = [];
    const descs = [];
    const urls = [];
    for (const f of files) {
        const dataUrl = await getBase64Async(await ensureImageFormatSupported(f));
        const b64 = String(dataUrl).split(',')[1];
        const path = await saveBase64AsFile(b64, ctx.name2, '', getFileExtension(f));
        saved.push({ url: path, type: MEDIA_TYPE.IMAGE, title: baseText || 'image', source: MEDIA_SOURCE.UPLOAD });
        const img = document.createElement('img');
        img.src = dataUrl; img.className = 'dsh-vision-thumb';
        thumbs.append(img);
    }
    sendBtn.disabled = false;
    if (S().enabled) {
        for (let i = 0; i < saved.length; i++) {
            statusEl.textContent = `识别中 ${i + 1}/${saved.length}…`;
            try {
                const d = await describeOne(saved[i], baseText);
                if (d) descs.push(saved.length > 1 ? `图${i + 1}：${d}` : d);
            } catch (e) {
                console.warn('[vision-bridge] describe', e);
                statusEl.textContent = '识图失败，可手动写描述或直接发送';
            }
        }
        if (descs.length) {
            const block = '\n\n[图片内容：' + descs.join('\n') + ']';
            textEl.value = String(textEl.value || '').trimEnd() + block;
            statusEl.textContent = '已识别，可修改描述后再发送';
        } else {
            statusEl.textContent = '没有识别结果，可直接发送原图';
        }
    } else {
        statusEl.textContent = '已关闭识图，直接发送原图';
    }

    sendBtn.addEventListener('click', async () => {
        const text = String(textEl.value || '').trim();
        if (!saved.length) return;
        const message = {
            name: ctx.name1,
            is_user: true,
            send_date: getMessageTimeStamp(),
            mes: text,
            extra: {
                dsh_vision_key: saved.map(m => m.url).join('|'),
                media: saved,
                media_display: MEDIA_DISPLAY.GALLERY,
                media_index: 0,
                inline_image: true,
            },
        };
        closePreview();
        if (ta) ta.value = '';
        ctx.chat.push(message);
        ctx.addOneMessage(message);
        if (typeof Generate === 'function') await Generate('normal');
    });
}

async function sendImageFile(file) {
    // 保留给自动化/测试：直接入队，不弹预览
    const ctx = getContext();
    const dataUrl = await getBase64Async(await ensureImageFormatSupported(file));
    const path = await saveBase64AsFile(String(dataUrl).split(',')[1], ctx.name2, '', getFileExtension(file));
    const message = {
        name: ctx.name1,
        is_user: true,
        send_date: getMessageTimeStamp(),
        mes: '',
        extra: { dsh_vision_key: path, media: [{ url: path, type: MEDIA_TYPE.IMAGE, source: MEDIA_SOURCE.UPLOAD }], inline_image: true },
    };
    ctx.chat.push(message);
    ctx.addOneMessage(message);
    if (typeof Generate === 'function') await Generate('normal');
}

globalThis.__DSH_SEND_IMAGE_FILE = sendImageFile;
globalThis.__DSH_OPEN_PREVIEW = openPreview;

jQuery(async () => {
    S();
    mountSettings();
    addImageButton();
    setTimeout(addImageButton, 1200);
    setInterval(() => { if (!document.getElementById('dsh-attach-image')) addImageButton(); }, 2500);
});

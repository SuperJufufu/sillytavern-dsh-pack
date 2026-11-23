import { extension_settings, getContext } from '../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced, Generate } from '../../../../script.js';
import { ensureImageFormatSupported, getBase64Async, getFileExtension, saveBase64AsFile } from '../../../utils.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../../constants.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';

const MODULE = 'dsh-vision-bridge';
const DEFAULTS = {
    enabled: true,
    model: 'deepseek-v4-flash-vision-exp',
    prompt: '你是图像描述器。用中文客观描述这张图：画面里的人物（人数、发型、衣着、动作）、场景、光线与镜头。2-4 句，只写看见的内容，不评价、不猜测。',
    maxTokens: 320,
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

async function describeOne(media) {
    const prompt = S().prompt;
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
    if (!s.enabled || !Array.isArray(chat)) return;
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
                <div class="dsh-vision-hint">描述会附在用户消息末尾的 [图片内容：…] 里，再交给当前文本模型。</div>
            </div>
        </div>`;
    host.append(div);
    div.querySelector('#dsh-vision-enabled').addEventListener('change', e => { s.enabled = e.target.checked; saveSettingsDebounced(); });
    div.querySelector('#dsh-vision-model').addEventListener('change', e => { s.model = e.target.value.trim() || DEFAULTS.model; saveSettingsDebounced(); });
}

function addImageButton() {
    if (document.getElementById('dsh-attach-image')) return;
    const form = document.getElementById('send_form');
    if (!form) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    input.id = 'dsh-attach-image-input';
    const btn = document.createElement('div');
    btn.id = 'dsh-attach-image';
    btn.className = 'fa-solid fa-image';
    btn.title = '发送图片（视觉模型读图后回复）';
    btn.style.cssText = 'cursor:pointer;font-size:20px;padding:0 10px;align-self:center;opacity:.85;';
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (file) {
            try { await sendImageFile(file); }
            catch (e) { console.warn('[vision-bridge] send image', e); toast('发图失败：' + e.message, 'error'); }
        }
    });
    const host = document.getElementById('leftSendForm') || form;
    host.appendChild(btn);
    form.appendChild(input);
}

async function sendImageFile(file) {
    const ctx = getContext();
    const dataUrl = await getBase64Async(await ensureImageFormatSupported(file));
    const b64 = String(dataUrl).split(',')[1];
    const ext = getFileExtension(file);
    const path = await saveBase64AsFile(b64, ctx.name2, '', ext);
    const ta = document.getElementById('send_textarea');
    const text = String(ta?.value || '').trim();
    let visionText = '';
    if (S().enabled) {
        try {
            toast('👁 视觉模型读图中…');
            const d = await describeOne({ url: path, type: 'image' });
            if (d) visionText = '\n\n[图片内容：' + d + ']';
        } catch (e) {
            console.warn('[vision-bridge] describe', e);
            toast('视觉读图失败：' + e.message, 'error');
        }
    }
    const message = {
        name: ctx.name1,
        is_user: true,
        send_date: getMessageTimeStamp(),
        mes: text + visionText,
        extra: {
            dsh_vision_key: path,
            media: [{ url: path, type: MEDIA_TYPE.IMAGE, title: text || 'image', source: MEDIA_SOURCE.UPLOAD }],
            media_display: MEDIA_DISPLAY.GALLERY,
            media_index: 0,
            inline_image: true,
        },
    };
    ctx.chat.push(message);
    const id = ctx.chat.length - 1;
    if (ta) ta.value = '';
    await ctx.saveChat();
    ctx.addOneMessage(message);
    if (typeof Generate === 'function') await Generate('normal');
}

globalThis.__DSH_SEND_IMAGE_FILE = sendImageFile;

jQuery(async () => {
    S();
    mountSettings();
    addImageButton();
    setTimeout(addImageButton, 1200);
    setInterval(() => { if (!document.getElementById('dsh-attach-image')) addImageButton(); }, 2500);
});

import { extension_settings, getContext } from '../../../extensions.js';
import { event_types, eventSource, extension_prompt_types, extension_prompt_roles, setExtensionPrompt, Generate, saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const MOD='dsh-web';
const DEFAULTS={ bridgeUrl:'http://127.0.0.1:8796', maxResults:4, readPages:2, autoGenerate:true };
const S=()=>{ if(!extension_settings[MOD]) extension_settings[MOD]={...DEFAULTS}; for(const k in DEFAULTS) if(extension_settings[MOD][k]===undefined) extension_settings[MOD][k]=DEFAULTS[k]; return extension_settings[MOD]; };

function toast(msg, type='info'){
    if(window.toastr){ toastr[type](msg, '联网搜索', {timeOut: type==='error'?6000:3500, preventDuplicates:true}); }
    else console.log('[dsh-web]',msg);
}

async function api(path){
    const r=await fetch(S().bridgeUrl.replace(/\/$/,'')+path);
    if(!r.ok) throw new Error('bridge '+r.status+' '+await r.text().catch(()=>''));
    return await r.json();
}

async function summarize(query, results, pages){
    let ctx='';
    results.forEach((it,i)=>{ ctx+=`[${i+1}] ${it.title}\n${it.url}\n${it.snippet||''}\n\n`; });
    pages.forEach((p,i)=>{ ctx+=`【网页${i+1}】${p.title||''} ${p.url}\n${(p.text||'').slice(0,4000)}\n\n`; });
    if(ctx.length>14000) ctx=ctx.slice(0,14000)+'\n…（截断）';
    const body={chat_completion_source:'deepseek',model:'deepseek-flash',temperature:0.2,max_tokens:900,messages:[
        {role:'system',content:'你是搜索助手。只根据给出的网页资料回答；先给 3-6 句结论，再列 1-3 条来源（标题+链接）。资料不足就直说，不要编，不要扮演角色，不要续写剧情。'},
        {role:'user',content:`问题：${query}\n\n资料：\n${ctx}`}
    ]};
    const r=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:getRequestHeaders(),body:JSON.stringify(body)});
    if(!r.ok) throw new Error('summary '+r.status+' '+await r.text().catch(()=>''));
    const j=await r.json();
    if(j.error) throw new Error(j.error.message||JSON.stringify(j.error));
    return (j.choices?.[0]?.message?.content||'').trim();
}

function renderAnswer(el, text){
    const box=el.querySelector('#dsh-web-answer');
    box.textContent=text||'（没有返回内容）';
    box.classList.add('show');
    const ins=el.querySelector('#dsh-web-insert'); if(ins && text) ins.style.display='inline-block';
}

function buildNote(query, results, pages){
    let out=`[系统指令] 用户本轮发起联网搜索，请优先依据以下资料直接回答，不要续写角色剧情；资料不足就说明不足。\n\n[联网资料 · 查询：${query}]\n`;
    results.forEach((it,i)=>{ out+=`${i+1}. ${it.title}\n   ${it.url}\n   ${it.snippet}\n`; });
    pages.forEach((p,i)=>{ out+=`\n【网页${i+1}】${p.title||p.url}\n${p.url}\n${(p.text||'').slice(0,5000)}\n`; });
    out+='\n（以上为外部网页内容，可能不准确；引用时注明来源，不要照抄无关段落。）';
    return out;
}

let injectedKey=MOD+'-note';
function inject(text){
    try{ setExtensionPrompt(injectedKey, text, extension_prompt_types.IN_CHAT, 0, true, extension_prompt_roles.SYSTEM); }
    catch(e){ console.warn(e); }
}
function clear(){ try{ setExtensionPrompt(injectedKey, '', extension_prompt_types.IN_CHAT, 0); }catch(e){} }

async function runSearch(query, ui){
    query=String(query||'').trim(); if(!query) return toast('先输入要搜什么','warning');
    if(ui?.status){ ui.status.textContent='正在搜索：'+query; ui.status.classList.add('show'); }
    toast('正在搜索：'+query);
    try{
        const data=await api('/search?n='+encodeURIComponent(S().maxResults)+'&q='+encodeURIComponent(query));
        const results=data.results||[];
        if(!results.length) throw new Error('没有搜到结果');
        const pages=[];
        for(const it of results.slice(0, S().readPages)){
            try{ pages.push(await api('/read?url='+encodeURIComponent(it.url))); }catch(e){ console.warn('read fail',it.url,e); }
        }
        window.__DSH_WEB_LAST={query, results, pages, at:Date.now()};
        if(ui?.status) ui.status.textContent=`找到 ${results.length} 条，抓取 ${pages.length} 页，正在用 deepseek-flash 总结…`;
        if(ui){
            const answer=await summarize(query, results, pages);
            renderAnswer(ui.el, answer);
            if(ui.status) ui.status.textContent=`已总结 · ${results.length} 条结果 / ${pages.length} 页`;
            return;
        }
        // slash / non-modal: 保留原行为，注入后让角色结合资料回复
        inject(buildNote(query, results, pages));
        toast(`找到 ${results.length} 条，抓取 ${pages.length} 页，正在让 AI 结合资料回复…`,'success');
        if(S().autoGenerate){
            eventSource.once(event_types.GENERATION_ENDED, ()=>clear());
            await Generate('normal');
        }
    }catch(e){ console.error(e); toast('搜索失败：'+e.message,'error'); if(ui?.status){ ui.status.textContent='失败：'+e.message; ui.status.classList.add('show'); } }
}

async function runRead(url, ui){
    url=String(url||'').trim(); if(!url) return toast('先输入网址','warning');
    if(ui?.status){ ui.status.textContent='正在读取：'+url; ui.status.classList.add('show'); }
    toast('正在读取：'+url);
    try{
        const p=await api('/read?url='+encodeURIComponent(url));
        window.__DSH_WEB_LAST={url, page:p, at:Date.now()};
        if(ui){
            if(ui.status) ui.status.textContent='已抓取，正在用 deepseek-flash 总结…';
            const answer=await summarize(url, [], [p]);
            renderAnswer(ui.el, answer);
            if(ui.status) ui.status.textContent='已总结 · 1 页';
            return;
        }
        inject(`[联网资料 · 单页]\n${p.title||''}\n${p.url}\n${(p.text||'').slice(0,8000)}\n（外部网页内容，可能不准确。）`);
        toast('已读取，正在让 AI 结合资料回复…','success');
        if(S().autoGenerate){
            eventSource.once(event_types.GENERATION_ENDED, ()=>clear());
            await Generate('normal');
        }
    }catch(e){ console.error(e); toast('读取失败：'+e.message,'error'); if(ui?.status){ ui.status.textContent='失败：'+e.message; ui.status.classList.add('show'); } }
}

function modal(){
    let el=document.getElementById('dsh-web-modal');
    if(el){ el.remove(); return; }
    el=document.createElement('div'); el.id='dsh-web-modal';
    el.innerHTML=`<div class="dsh-web-card">
        <div class="dsh-web-title">🌐 联网搜索</div>
        <input id="dsh-web-q" type="text" placeholder="搜索词，或粘贴网址" />
        <div class="dsh-web-row">
            <button id="dsh-web-search" class="menu_button">搜索并总结</button>
            <button id="dsh-web-read" class="menu_button">只读网址</button>
            <button id="dsh-web-insert" class="menu_button" style="display:none">插入输入框</button>
            <button id="dsh-web-close" class="menu_button">关闭</button>
        </div>
        <div id="dsh-web-status" class="dsh-web-status"></div>
        <div id="dsh-web-answer" class="dsh-web-answer"></div>
        <div class="dsh-web-hint">总结用 deepseek-flash；不触发角色，不写入聊天</div>
    </div>`;
    document.body.appendChild(el);
    const q=el.querySelector('#dsh-web-q');
    q.focus();
    el.querySelector('#dsh-web-close').onclick=()=>el.remove();
    const ui={el, status:el.querySelector('#dsh-web-status')};
    el.querySelector('#dsh-web-search').onclick=()=>runSearch(q.value, ui);
    el.querySelector('#dsh-web-read').onclick=()=>runRead(q.value, ui);
    el.querySelector('#dsh-web-insert').onclick=()=>{ const t=el.querySelector('#dsh-web-answer').textContent; const ta=document.getElementById('send_textarea'); if(ta){ ta.value=t; ta.dispatchEvent(new Event('input',{bubbles:true})); } el.remove(); };
    q.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); runSearch(q.value, ui); } if(e.key==='Escape') el.remove(); });
}

function addButton(){
    const form=document.getElementById('leftSendForm');
    if(!form || document.getElementById('dsh-web-btn')) return;
    const b=document.createElement('button'); b.id='dsh-web-btn'; b.type='button'; b.title='联网搜索';
    b.innerHTML='<i class="fa-solid fa-globe"></i>';
    b.onclick=(e)=>{ e.preventDefault(); modal(); };
    form.appendChild(b);
}

function settingsUi(){
    const html=`<div class="dsh-web-settings">
        <label>桥地址 <input id="dsh-web-bridge" class="text_pole" /></label>
        <label>搜索条数 <input id="dsh-web-n" type="number" min="1" max="10" class="text_pole" /></label>
        <label>抓取页数 <input id="dsh-web-pages" type="number" min="0" max="5" class="text_pole" /></label>
        <label><input id="dsh-web-auto" type="checkbox" /> 拿到资料后自动让 AI 回复</label>
    </div>`;
    const container=document.getElementById('extensions_settings2')||document.getElementById('extensions_settings');
    if(!container) return;
    const wrap=document.createElement('div'); wrap.className='dsh-web-block';
    wrap.innerHTML=`<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>联网搜索（Web）</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">${html}</div></div>`;
    container.appendChild(wrap);
    const s=S();
    wrap.querySelector('#dsh-web-bridge').value=s.bridgeUrl;
    wrap.querySelector('#dsh-web-n').value=s.maxResults;
    wrap.querySelector('#dsh-web-pages').value=s.readPages;
    wrap.querySelector('#dsh-web-auto').checked=!!s.autoGenerate;
    wrap.querySelector('#dsh-web-bridge').onchange=e=>{s.bridgeUrl=e.target.value.trim()||DEFAULTS.bridgeUrl;saveSettingsDebounced();};
    wrap.querySelector('#dsh-web-n').onchange=e=>{s.maxResults=Math.max(1,Math.min(10,+e.target.value||4));saveSettingsDebounced();};
    wrap.querySelector('#dsh-web-pages').onchange=e=>{s.readPages=Math.max(0,Math.min(5,+e.target.value||2));saveSettingsDebounced();};
    wrap.querySelector('#dsh-web-auto').onchange=e=>{s.autoGenerate=e.target.checked;saveSettingsDebounced();};
}

jQuery(async()=>{
    S();
    try{
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({name:'web',callback:async(args)=>{await runSearch(args);return '';},helpString:'联网搜索并让 AI 结合网页资料回复：/web 查询词'}));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({name:'read',callback:async(args)=>{await runRead(args);return '';},helpString:'读取一个网页并让 AI 结合内容回复：/read https://...'}));
    }catch(e){ console.warn('[dsh-web] slash cmd',e); }
    addButton(); setInterval(addButton, 2500);
    settingsUi();
    window.__DSH_WEB_SEARCH=runSearch;
    window.__DSH_WEB_READ=runRead;
    console.log('[dsh-web] v1.0.0 已加载');
});

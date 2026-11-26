import { extension_settings, getContext } from '../../../extensions.js';
import { event_types, eventSource, extension_prompt_types, extension_prompt_roles, setExtensionPrompt, Generate, saveSettingsDebounced } from '../../../../script.js';
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

async function runSearch(query){
    query=String(query||'').trim(); if(!query) return toast('先输入要搜什么','warning');
    toast('正在搜索：'+query);
    try{
        const data=await api('/search?n='+encodeURIComponent(S().maxResults)+'&q='+encodeURIComponent(query));
        const results=data.results||[];
        if(!results.length) return toast('没有搜到结果','warning');
        const pages=[];
        for(const it of results.slice(0, S().readPages)){
            try{ pages.push(await api('/read?url='+encodeURIComponent(it.url))); }catch(e){ console.warn('read fail',it.url,e); }
        }
        const note=buildNote(query, results, pages);
        inject(note);
        window.__DSH_WEB_LAST={query, results, pages, at:Date.now()};
        toast(`找到 ${results.length} 条，抓取 ${pages.length} 页，正在让 AI 结合资料回复…`,'success');
        if(S().autoGenerate){
            eventSource.once(event_types.GENERATION_ENDED, ()=>clear());
            await Generate('normal');
        }
    }catch(e){ console.error(e); toast('搜索失败：'+e.message,'error'); }
}

async function runRead(url){
    url=String(url||'').trim(); if(!url) return toast('先输入网址','warning');
    toast('正在读取：'+url);
    try{
        const p=await api('/read?url='+encodeURIComponent(url));
        inject(`[联网资料 · 单页]\n${p.title||''}\n${p.url}\n${(p.text||'').slice(0,8000)}\n（外部网页内容，可能不准确。）`);
        window.__DSH_WEB_LAST={url, page:p, at:Date.now()};
        toast('已读取，正在让 AI 结合资料回复…','success');
        if(S().autoGenerate){
            eventSource.once(event_types.GENERATION_ENDED, ()=>clear());
            await Generate('normal');
        }
    }catch(e){ console.error(e); toast('读取失败：'+e.message,'error'); }
}

function modal(){
    let el=document.getElementById('dsh-web-modal');
    if(el){ el.remove(); return; }
    el=document.createElement('div'); el.id='dsh-web-modal';
    el.innerHTML=`<div class="dsh-web-card">
        <div class="dsh-web-title">🌐 联网搜索</div>
        <input id="dsh-web-q" type="text" placeholder="搜索词，或粘贴网址" />
        <div class="dsh-web-row">
            <button id="dsh-web-search" class="menu_button">搜索并回复</button>
            <button id="dsh-web-read" class="menu_button">只读网址</button>
            <button id="dsh-web-close" class="menu_button">关闭</button>
        </div>
        <div class="dsh-web-hint">/web 查询词 · /read 网址 · 结果会注入本轮提示词</div>
    </div>`;
    document.body.appendChild(el);
    const q=el.querySelector('#dsh-web-q');
    q.focus();
    el.querySelector('#dsh-web-close').onclick=()=>el.remove();
    el.querySelector('#dsh-web-search').onclick=()=>{ const v=q.value; el.remove(); runSearch(v); };
    el.querySelector('#dsh-web-read').onclick=()=>{ const v=q.value; el.remove(); runRead(v); };
    q.addEventListener('keydown',e=>{ if(e.key==='Enter'){ const v=q.value; el.remove(); runSearch(v); } if(e.key==='Escape') el.remove(); });
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

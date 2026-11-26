import http from 'node:http';
import { URL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const PORT = 8796;
let baiduCookie = '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function decode(s='') {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)))
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}

async function resolveBaidu(href){
  try{
    if(!/baidu\.com\/link\?url=/.test(href)) return href;
    const r=await fetch(href,{redirect:'manual',headers:{'user-agent':UA},signal:AbortSignal.timeout(5000)});
    return r.headers.get('location')||href;
  }catch(e){ return href; }
}

async function searchBaiduMobile(q, n){
  const r=await fetch('https://www.baidu.com/s?wd='+encodeURIComponent(q),{headers:{'user-agent':'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36','accept-language':'zh-CN,zh;q=0.9'},signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error('baidu-m '+r.status);
  const html=await r.text();
  if(/安全验证|验证码/.test(html.slice(0,2000))) throw new Error('baidu-m captcha');
  const out=[]; const re=/<!--s-text-->([\s\S]*?)<!--\/s-text-->/g; let m;
  while((m=re.exec(html)) && out.length<n){
    const title=decode(m[1]).replace(/\s+/g,' ').trim(); if(!title || title.length<4) continue;
    const seg=html.slice(Math.max(0,m.index-3500), m.index+800);
    const cands=[...seg.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(x=>x[0].replace(/&amp;/g,'&'))
      .filter(u=>!/m\.baidu\.com\/from=|baidu\.com\/it\/u=|bdstatic|\.(jpg|png|gif|webp)(\?|$)/i.test(u));
    let url=cands[cands.length-1]; if(!url) continue;
    url=url.split(/&quot;|"|\\/)[0];
    const after=html.slice(re.lastIndex, re.lastIndex+1200);
    const sm=after.match(/summary-text_[^"]*">([\s\S]*?)<\/span>/);
    out.push({title,url,snippet:sm?decode(sm[1]).slice(0,240):'',engine:'baidu-m'});
  }
  return out;
}

async function searchDDG(q, n){
  const url='https://html.duckduckgo.com/html/?q='+encodeURIComponent(q);
  const args=['-s','-L','--max-time','20','-x','http://127.0.0.1:7890','-A',UA,url];
  const { stdout } = await execFileP('C:\\Windows\\System32\\curl.exe', args, { maxBuffer: 8*1024*1024, timeout: 25000 });
  if(!stdout || stdout.length<500) throw new Error('ddg empty');
  if(/anomaly|challenge|blocked/i.test(stdout.slice(0,2000))) throw new Error('ddg challenge');
  const out=[];
  const re=/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi; let m;
  while((m=re.exec(stdout)) && out.length<n){
    let href=m[1].replace(/&amp;/g,'&');
    const u=new URL(href.startsWith('//')?'https:'+href:href);
    const ud=u.searchParams.get('uddg'); if(ud) href=decodeURIComponent(ud);
    const title=decode(m[2]).replace(/\s+/g,' ').trim(); if(!title) continue;
    const tail=stdout.slice(re.lastIndex, re.lastIndex+1200);
    const sm=tail.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet=sm?decode(sm[1]).slice(0,240):'';
    out.push({title,url:href,snippet,engine:'ddg'});
  }
  return out;
}

async function searchSogou(q, n){
  const r=await fetch('https://www.sogou.com/web?query='+encodeURIComponent(q),{headers:{'user-agent':UA,'accept-language':'zh-CN,zh;q=0.9'},signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error('sogou '+r.status);
  const html=await r.text();
  if(/验证码|安全验证/.test(html)) throw new Error('sogou captcha');
  const out=[];
  const re=/<h3[^>]*>([\s\S]*?)<\/h3>/gi; let m;
  while((m=re.exec(html)) && out.length<n){
    const a=m[1].match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i); if(!a) continue;
    const title=decode(a[2]).replace(/\s+/g,' ').trim(); if(!title) continue;
    let href=a[1].replace(/&amp;/g,'&');
    if(href.startsWith('/')) href='https://www.sogou.com'+href;
    const tail=html.slice(re.lastIndex, re.lastIndex+600);
    const snippet=decode(tail.replace(/<[^>]+>/g,' ')).slice(0,240);
    out.push({title,url:href,snippet,engine:'sogou'});
  }
  await Promise.all(out.map(async it=>{
    try{
      if(/sogou\.com\/link\?url=/.test(it.url)){
        const rr=await fetch(it.url,{redirect:'manual',headers:{'user-agent':UA},signal:AbortSignal.timeout(5000)});
        it.url=rr.headers.get('location')||it.url;
      }
    }catch(e){}
  }));
  return out;
}

async function searchBaidu(q, n){
  const r=await fetch('https://www.baidu.com/s?wd='+encodeURIComponent(q)+'&rn='+Math.max(10,n),{headers:{'user-agent':UA,'accept-language':'zh-CN,zh;q=0.9',...(baiduCookie?{'cookie':baiduCookie}:{})},signal:AbortSignal.timeout(15000)});
try{ const sc=r.headers.getSetCookie?.()||[]; const b=sc.map(c=>c.split(';')[0]).find(c=>c.startsWith('BAIDUID=')); if(b) baiduCookie=b; }catch(e){}
  if(!r.ok) throw new Error('baidu '+r.status);
  const html=await r.text();
  if(/百度安全验证|验证码/.test(html)) throw new Error('baidu captcha');
  const out=[];
  const re=/<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let m;
  while((m=re.exec(html)) && out.length<n){
    const a=m[1].match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if(!a) continue;
    const title=decode(a[2]).replace(/\s+/g,' ').trim();
    if(!title || /百度一下|搜索工具/.test(title)) continue;
    const tail=html.slice(re.lastIndex, re.lastIndex+600);
    let snippet=decode(tail.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ')).slice(0,240);
    out.push({title,url:a[1].replace(/&amp;/g,'&'),snippet,engine:'baidu'});
  }
  await Promise.all(out.map(async it=>{ it.url=await resolveBaidu(it.url); }));
  return out;
}

async function searchBing(q, n){
  const r=await fetch('https://www.bing.com/search?q='+encodeURIComponent(q)+'&setlang=zh-Hans&count='+Math.max(10,n),{headers:{'user-agent':UA,'accept-language':'zh-CN,zh;q=0.9'},signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error('bing '+r.status);
  const html=await r.text();
  const out=[];
  const blocks=html.split(/<li[^>]+class="[^"]*b_algo[^"]*"/i).slice(1);
  for(const b of blocks){
    if(out.length>=n) break;
    const a=b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i); if(!a) continue;
    const p=b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({title:decode(a[2]),url:a[1],snippet:p?decode(p[1]).slice(0,240):'',engine:'bing'});
  }
  return out;
}

async function search(q, n=5) {
  const engines=[searchBaiduMobile, searchSogou, searchBaidu, searchBing];
  let lastErr=null;
  const tokens=String(q).toLowerCase().split(/\s+/).filter(t=>t.length>=2 && !/^(是什么|什么|怎么|如何|介绍|世界观)$/.test(t));
  const relevant=(it)=>{
    const text=((it.title||'')+' '+(it.snippet||'')).toLowerCase();
    if(!tokens.length) return true;
    return tokens.some(t=>text.includes(t));
  };
  for(const fn of engines){
    try{ const all=await fn(q,n); const r=all.filter(relevant); if(r.length) return r; }catch(e){ lastErr=e; }
  }
  throw new Error('没有找到相关结果（搜索源可能临时限流，请稍后再试）');
}

function extract(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'');
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi,' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi,'\n')
    .replace(/<[^>]+>/g,' ');
  s = decode(s).replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
  return { title, text: s.slice(0, 14000) };
}

async function readUrl(url) {
  const r = await fetch(url, { redirect:'follow', headers:{ 'user-agent':UA, 'accept-language':'zh-CN,zh;q=0.9,en;q=0.7' }, signal: AbortSignal.timeout(20000) });
  const ct = r.headers.get('content-type')||'';
  if (!/text|html|xml|json/i.test(ct)) throw new Error('unsupported content-type: '+ct);
  const html = await r.text();
  return { url: r.url, status: r.status, ...extract(html) };
}

const srv = http.createServer(async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  try{
    const u = new URL(req.url, 'http://x');
    if(u.pathname==='/health'){ return res.end(JSON.stringify({ok:true,port:PORT})); }
    if(u.pathname==='/search'){
      const q=u.searchParams.get('q'); if(!q) throw new Error('missing q');
      const results=await search(q, +(u.searchParams.get('n')||5));
      return res.end(JSON.stringify({query:q,results}));
    }
    if(u.pathname==='/read'){
      const url=u.searchParams.get('url'); if(!url) throw new Error('missing url');
      return res.end(JSON.stringify(await readUrl(url)));
    }
    if(u.pathname==='/debug-search'){
      const q=u.searchParams.get('q')||''; const out=[];
      for(const [name,fn] of [['baidu-m',searchBaiduMobile],['sogou',searchSogou],['baidu',searchBaidu],['bing',searchBing],['ddg',searchDDG]]){
        try{ const r=await fn(q,4); out.push({name,count:r.length,sample:r.slice(0,2).map(x=>x.title)}); }
        catch(e){ out.push({name,error:String(e.message||e).slice(0,160)}); }
      }
      return res.end(JSON.stringify({q,engines:out}));
    }
    res.statusCode=404; res.end(JSON.stringify({error:'not found'}));
  }catch(e){ res.statusCode=500; res.end(JSON.stringify({error:String(e.message||e)})); }
});
srv.listen(PORT,'127.0.0.1',()=>console.log('[web-bridge] http://127.0.0.1:'+PORT));

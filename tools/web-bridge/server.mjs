import http from 'node:http';
import { URL } from 'node:url';

const PORT = 8796;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function decode(s='') {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)))
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}

async function search(q, n=5) {
  const u = 'https://www.bing.com/search?format=rss&q=' + encodeURIComponent(q);
  const r = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7' } });
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,n).map(m=>{
    const b=m[1];
    const get=(t)=>{const x=b.match(new RegExp('<'+t+'>([\\s\\S]*?)<\\/'+t+'>'));return x?decode(x[1]):'';};
    return { title:get('title'), url:get('link'), snippet:get('description') };
  });
  return items;
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
    res.statusCode=404; res.end(JSON.stringify({error:'not found'}));
  }catch(e){ res.statusCode=500; res.end(JSON.stringify({error:String(e.message||e)})); }
});
srv.listen(PORT,'127.0.0.1',()=>console.log('[web-bridge] http://127.0.0.1:'+PORT));

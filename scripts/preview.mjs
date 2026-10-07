// Development-only preview: a browser storage stub, never included in the build.
import { createServer } from "node:http";
import { mockConnect } from "./mock-port.mjs";
import { readFile } from "node:fs/promises";

const root = new URL("../extension/", import.meta.url);
const mock = `const listeners = new Set();
const values = {enabled:true,keywords:['spoiler'],aiEnabled:true,openaiApiKey:'demo-key',keywordColor:'#ff0000',aiColor:'#8000ff',minProbability:.9,replacementStyle:'solid',keywordReplacementStyle:'blur',enabledClassifiers:["clickbait","fear_mongering","rage_bait","engagement_bait","artificial_urgency","wide_open_mouth"],hideEarlyExit:true,imageSize:"original",imageDetail:"high",popupTheme:'system'};
if(new URL(location.href).searchParams.has('long')) values.keywords=['a very long keyword phrase that should wrap safely inside a chip',...Array.from({length:20},(_,index)=>'example phrase '+(index+1))];
let revision = 0, scoreRevision = 0;
let spendingPreview;
function analyticsPreview() {
  if (spendingPreview) return spendingPreview;
  const api = window.ThumbnailSpending;
  const ledger = api.create();
  const scenario = new URL(location.href).searchParams.get('spend') || 'normal';
  const count = scenario === 'zero' ? 0 : scenario === 'tiny' ? 1 : scenario === 'large' ? 100000000000 : 345000;
  const totals = {...ledger.totals,attempts:count ? 12 : 0,inputTokens:count,outputTokens:count ? 240 : 0,costNanodollars:count*100,tests:count ? 1 : 0};
  if (scenario === 'incomplete') {totals.unresolved=2;totals.unpriced=1;totals.attempts+=3;}
  ledger.totals=totals;
  ledger.days[api.dayAt(Date.now(),ledger.timeZone)]={...totals};
  if (scenario === 'pending') ledger.pending.demo={startedAt:Date.now(),kind:'automatic'};
  spendingPreview={ok:true,ledger,warning:scenario === 'storage' ? 'Spending history could not be saved. These totals include unsaved activity.' : ''};
  return spendingPreview;
}
function patternPreview(message) {
  const empty = new URL(location.href).searchParams.get('patterns') === 'empty';
  const limited = new URL(location.href).searchParams.get('patterns') === 'limited';
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = window.ThumbnailSpending.dayAt(Date.now(), zone);
  const shift = (day, amount) => new Date(Date.parse(day+'T00:00:00Z')+amount*86400000).toISOString().slice(0,10);
  const start = message.period === 'today' ? today : message.period === 'month' ? today.slice(0,7)+'-01' : message.period === '30days' ? shift(today,-29) : shift(today,-((new Date(today+'T00:00:00Z').getUTCDay()+6)%7));
  const totals = {encountered:120,filtered:60,keyword:42,ai:18,clear:50,pending:5,unavailable:3,unchecked:2,keywords:{crypto:35,spoiler:21,reaction:12},categories:{}};
  for (const id of ThumbnailClassifiers.ids) totals.categories[id]={evaluated:68,qualified:id==='clickbait'?12:id==='rage_bait'?8:id==='shopping_pressure'?7:0,shown:id==='clickbait'?10:id==='rage_bait'?4:id==='shopping_pressure'?4:0};
  if(empty) {for(const key of ['encountered','filtered','keyword','ai','clear','pending','unavailable','unchecked']) totals[key]=0;totals.keywords={};for(const value of Object.values(totals.categories)) Object.assign(value,{evaluated:0,qualified:0,shown:0});}
  const daily=[];
  for(let day=start,index=0;day<=today;day=shift(day,1),index++) daily.push({day,count:empty?0:message.metric?.startsWith('category:')?2+index%4:message.metric?.startsWith('keyword:')?3+index%5:5+index%7,denominator:empty?0:15+index%10,changes:!empty&&index===1?[{at:Date.now(),fields:['Keywords','Probability threshold']}]:[]});
  return {ok:true,totals,daily,keywords:empty?[]:['crypto','reaction','spoiler'],comparison:{available:!empty&&daily.length>1,days:daily.length-1,current:{count:12,denominator:40},previous:{count:8,denominator:40}},startedAt:Date.now()-70*86400000,timeZone:zone,retentionDays:90,truncated:limited,warning:limited?'Some older observations were removed by the local storage limit.':''};
}
const publicSettings = () => ({enabled:values.enabled,keywords:values.keywords,aiEnabled:values.aiEnabled,keyConfigured:!!values.openaiApiKey,aiRevision:String(revision),scoreRevision:String(scoreRevision),keywordColor:values.keywordColor,aiColor:values.aiColor,minProbability:values.minProbability,replacementStyle:values.replacementStyle,keywordReplacementStyle:values.keywordReplacementStyle,hideEarlyExit:values.hideEarlyExit,imageSize:values.imageSize,imageDetail:values.imageDetail,enabledClassifiers:ThumbnailClassifiers.normalize(values.enabledClassifiers),classificationVersion:ThumbnailClassifiers.schemaVersion});
window.chrome = { runtime: {sendMessage: async message => {
  if (message.type === 'get-analytics') return analyticsPreview();
  if (message.type === 'get-patterns') return patternPreview(message);
  if (message.type === 'record-patterns') return {ok:true};
  if (message.type === 'get-settings') return {ok:true,settings:publicSettings()};
  if (message.type === 'test-openai') return {ok:true};
  const simulatedCategory = new URL(location.href).searchParams.get("classifier");
  const label = message.title.includes("Sponsored") ? (ThumbnailClassifiers.ids.includes(simulatedCategory) ? simulatedCategory : "sponsorships_sales_pitches") : message.title.includes("wealth") ? 'get_rich_quick' : message.title.includes("believe") ? 'clickbait' : message.title.includes("fear") ? 'fear_mongering' : null;
  return {ok:true,aiRevision:String(revision),schemaVersion:ThumbnailClassifiers.schemaVersion,
    results:Object.fromEntries(ThumbnailClassifiers.normalize(values.enabledClassifiers).filter(id => !ThumbnailClassifiers.isImage(id) || message.thumbnailUrl).map(id => [id,{
      probability:id===label?.925:.02
    }]))};
}}, storage: {
  session: {get: async defaults => defaults},
  local: {
    get: async defaults => ({...defaults, ...values}),
    set: async patch => {
      const changes = {};
      for (const [key, value] of Object.entries(patch)) changes[key] = {newValue: value};
      Object.assign(values, patch);
      if ('openaiApiKey' in patch) scoreRevision++;
      if (['enabled','aiEnabled','openaiApiKey','enabledClassifiers','minProbability','replacementStyle','hideEarlyExit','imageSize','imageDetail'].some(key => key in patch)) revision++;
      for (const listener of listeners) listener(changes, 'local');
      for (const listener of listeners) listener({publicSettings:{newValue:publicSettings()}}, 'session');
    }
  },
  onChanged: {addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn)}
}};
window.chrome.runtime.connect = (${mockConnect.toString()})(window.chrome.runtime.sendMessage);
document.addEventListener('DOMContentLoaded', () => {
  const privacy = document.querySelector('.privacy');
  if (privacy) {privacy.textContent = 'Preview only · simulated AI and storage · no real keys';return;}
  const notice = document.createElement('p');
  notice.textContent = 'Preview only: simulated AI and storage. Do not enter a real API key.';
  notice.style.cssText = 'padding:12px;font:12px system-ui;color:#e7c98c';
  document.body.prepend(notice);
});`;
const art = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#55bcd7"/><circle cx="260" cy="35" r="22" fill="#ffda64"/><path d="M0 180L110 45 230 180M150 180L250 65 320 180" fill="#356a65"/></svg>');
const link = (id, content, attrs = "") => `<a href="https://www.youtube.com/watch?v=${id}" ${attrs}>${content}</a>`;
const heading = (id, title) => `<h3>${link(id, title, 'id="video-title"')}</h3>`;
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Thumbnail visual verification</title>
<link rel="stylesheet" href="/content.css"><style>
body{background:#171717;color:white;font:14px system-ui;padding:24px} main{display:flex;flex-wrap:wrap;gap:24px;margin-top:24px;align-items:flex-start}
ytd-rich-item-renderer,yt-lockup-view-model,ytd-compact-video-renderer,ytm-shorts-lockup-view-model,section.fallback{display:block;width:300px}
ytd-thumbnail,.ytLockupViewModelContentImage,.shortsLockupViewModelHostThumbnailContainer{display:block;position:relative;width:100%;aspect-ratio:16/9;border-radius:16px;overflow:hidden}
ytd-thumbnail a,.ytLockupViewModelContentImage>yt-thumbnail-view-model{display:block;width:100%;height:100%}
img{width:100%;height:100%;object-fit:cover} ytd-compact-video-renderer{width:168px}ytm-shorts-lockup-view-model{width:160px}.shortsLockupViewModelHostThumbnailContainer{aspect-ratio:9/16}
section.fallback{width:240px}section.fallback>a{display:block}section.fallback img{display:block;height:auto;border-radius:18px}
h3{font-size:14px}a{color:white;text-decoration:none}button,select{padding:9px;margin:0 4px 8px 0}label{display:inline-block}
#events{padding:12px;background:#242424} .fixture-label{color:#bbb;margin-bottom:8px}
ytd-thumbnail:hover,.ytLockupViewModelContentImage:hover{transform:scale(1.08)}
</style><script src="/preview-storage.js"></script><script src="/classifiers.js" defer></script><script src="/thumbnail-images.js"></script><script src="/keywords.js" defer></script><script src="/ai-overlay.js" defer></script><script src="/content.js" defer></script></head><body>
<h1>Thumbnail verification</h1><p>Production content scripts, simulated match probability: 92.5%.</p>
<button onclick="chrome.storage.local.set({enabled:true,keywords:['spoiler'],aiEnabled:true,minProbability:.9,enabledClassifiers:null})">Enable filters</button>
<button onclick="chrome.storage.local.set({enabled:false})">Pause filters</button>
<button onclick="chrome.storage.local.set({keywordColor:'#008888',aiColor:'#ffcc00'})">Light colors</button>
<button onclick="chrome.storage.local.set({keywordColor:'#ff0000',aiColor:'#220044'})">Dark colors</button>
<button onclick="chrome.storage.local.set({minProbability:.93})">Require 93%</button>
<button onclick="document.querySelector('.fallback').style.width='180px'">Resize fallback</button>
<label>Keyword style <select aria-label="Keyword replacement" onchange="chrome.storage.local.set({keywordReplacementStyle:this.value})"><option value="solid">Solid</option><option value="blur" selected>Blur</option><option value="grayscale">Grayscale</option><option value="placeholder">Placeholder</option><option value="hide">Hide card</option></select></label>
<label>Classifier style <select aria-label="Classifier replacement" onchange="chrome.storage.local.set({replacementStyle:this.value})"><option value="solid">Solid</option><option value="blur">Blur</option><option value="grayscale">Grayscale</option><option value="placeholder">Placeholder</option><option value="hide">Hide card</option></select></label>
<button onclick="chrome.storage.local.set({enabledClassifiers:[]})">Clear categories</button>
<div id="events">Clicks: <span id="click-count">0</span> · Thumbnail hover events: <span id="hover-count">0</span></div>
<main>
<ytd-rich-item-renderer data-fixture="keyword"><div class="fixture-label">Keyword</div><ytd-thumbnail>${link('a', `<img src="${art}">`, 'aria-label="Keyword thumbnail"')}</ytd-thumbnail>${heading('a','A spoiler review')}</ytd-rich-item-renderer>
<yt-lockup-view-model data-fixture="standard"><div class="fixture-label">Standard</div>${link('b', `<yt-thumbnail-view-model><img src="${art}"></yt-thumbnail-view-model>`, 'class="ytLockupViewModelContentImage" aria-label="Standard thumbnail"')}${heading('b','Sponsored showcase: use my discount code')}</yt-lockup-view-model>
<ytd-compact-video-renderer data-fixture="compact"><div class="fixture-label">Compact</div><ytd-thumbnail>${link('c', `<img src="${art}">`, 'aria-label="Compact thumbnail"')}</ytd-thumbnail>${heading('c','Sponsored showcase: use my discount code')}</ytd-compact-video-renderer>
<ytm-shorts-lockup-view-model data-fixture="shorts"><div class="fixture-label">Shorts</div>${link('d', `<img src="${art}">`, 'class="shortsLockupViewModelHostThumbnailContainer" aria-label="Shorts thumbnail"')}${heading('d','Sponsored showcase: use my discount code')}</ytm-shorts-lockup-view-model>
<section class="fallback" data-fixture="fallback"><div class="fixture-label">Image only</div>${link('e', `<img data-thumb="https://i.ytimg.com/vi/e/default.jpg" src="${art}">`, 'title="Sponsored showcase: use my discount code" aria-label="Fallback thumbnail"')}${heading('e','Sponsored showcase: use my discount code')}</section>
<ytd-rich-item-renderer data-fixture="normal"><div class="fixture-label">Unmatched</div><ytd-thumbnail>${link('f', `<img src="${art}">`, 'aria-label="Normal thumbnail"')}</ytd-thumbnail>${heading('f','A peaceful walk')}</ytd-rich-item-renderer>
</main><script>
document.querySelectorAll('main a').forEach(link => link.addEventListener('click', event => {event.preventDefault(); document.querySelector('#click-count').textContent = Number(document.querySelector('#click-count').textContent)+1;}));
window.addEventListener('load',()=>document.querySelectorAll('ytd-thumbnail,.ytLockupViewModelContentImage,.shortsLockupViewModelHostThumbnailContainer,.fallback>a').forEach(node=>node.addEventListener('mouseover',()=>{document.querySelector('#hover-count').textContent=Number(document.querySelector('#hover-count').textContent)+1;})));
</script></body></html>`;
createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "popup.html";
  if (name === "hover-fixture.html") {
    response.setHeader("Content-Type", "text/html");
    const html = await readFile(new URL("./hover-fixture.html", import.meta.url), "utf8");
    response.end(html.replace("<!-- MOCK_PORT -->", `<script>window.chrome.runtime.connect = (${mockConnect.toString()})(window.chrome.runtime.sendMessage);</script>`));
    return;
  }
  if (name === "fixture.html") {
    response.setHeader("Content-Type", "text/html");
    response.end(fixture);
    return;
  }
  if (/^probe-image-[1-3]\.png$/.test(name)) {
    const names = ["Screenshot 2026-10-06 at 6.31.18\u202fPM.png", "Screenshot 2026-10-06 at 6.31.53\u202fPM.png", "Screenshot 2026-10-06 at 6.32.08\u202fPM.png"];
    try { response.setHeader("Content-Type", "image/png"); response.end(await readFile(`/Users/ivancampos/Desktop/${names[Number(name[12]) - 1]}`)); }
    catch { response.writeHead(404).end("Supplied screenshot unavailable."); }
    return;
  }
  if (name === "image-probe.html") { response.setHeader("Content-Type", "text/html"); response.end(await readFile(new URL("../verification/image-preparation.html", root), "utf8")); return; }
  if (name === "preview-storage.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(mock);
    return;
  }
  if (!["thumbnail-images.js", "popup.html", "popup.css", "popup.js", "spending.js", "analytics.js", "pattern-ui.js", "pattern-observer.js", "classifiers.js", "keywords.js", "ai-overlay.js", "content.js", "content.css"].includes(name)) {
    response.writeHead(404).end();
    return;
  }
  try {
    let content = await readFile(new URL(name, root), "utf8");
    if (name === "popup.html") content = content.replace('<script src="keywords.js"', '<script src="preview-storage.js"></script><script src="keywords.js"');
    response.setHeader("Content-Type", name.endsWith("html") ? "text/html" : name.endsWith("css") ? "text/css" : "text/javascript");
    response.end(content);
  } catch { response.writeHead(500).end(); }
}).listen(Number(process.env.PORT || 4317), "127.0.0.1", () => console.log(`Popup preview (mock storage): http://127.0.0.1:${process.env.PORT || 4317}`));

// Publica un post en Instagram (Business) vía Graph API. Token desde el env del servidor.
// Imagen servida desde este repo público (Meta no puede descargar del dominio por el WAF).
const FB_API = 'https://graph.facebook.com/v21.0';
const IMAGE = 'https://raw.githubusercontent.com/WayPool/jbhl-ig-promo/main/ig-promo-guia.png';
const CAPTION = `⚖️ Si te detienen o te citan como investigado, las primeras horas son decisivas.

Nueva guía con tus derechos, los plazos (72 h) y los errores que pueden costarte el caso.

📲 Guía completa en el enlace de la bio.

JBH conecta y coordina tu caso con abogados penalistas colegiados.

#DefensaPenal #DerechoPenal #Detención #Girona`;
const ut = process.env.META_ACCESS_TOKEN, ig = process.env.META_IG_USER_ID, page = process.env.META_FB_PAGE_ID;
if (!ut || !ig) { console.error('FALTA META_ACCESS_TOKEN / META_IG_USER_ID'); process.exit(2); }
const token = page ? (await (await fetch(`${FB_API}/${page}?fields=access_token&access_token=${encodeURIComponent(ut)}`)).json()).access_token || ut : ut;
let r = await fetch(`${FB_API}/${ig}/media`, { method:'POST', body:new URLSearchParams({ image_url:IMAGE, caption:CAPTION, access_token:token }) });
let j = await r.json(); if (!r.ok || !j.id) { console.error('CREATE FAIL', JSON.stringify(j)); process.exit(3); }
const cid = j.id; let ready=false;
for (let i=0;i<25;i++){ await new Promise(s=>setTimeout(s,3000)); const s=await (await fetch(`${FB_API}/${cid}?fields=status_code&access_token=${encodeURIComponent(token)}`)).json(); if(s.status_code==='FINISHED'){ready=true;break;} if(s.status_code==='ERROR'){console.error('PROCESS ERROR');process.exit(4);} }
if(!ready){ console.error('NOT READY'); process.exit(5); }
r = await fetch(`${FB_API}/${ig}/media_publish`, { method:'POST', body:new URLSearchParams({ creation_id:cid, access_token:token }) });
j = await r.json(); if(!r.ok || !j.id){ console.error('PUBLISH FAIL', JSON.stringify(j)); process.exit(6); }
console.log('PUBLISHED', j.id); process.exit(0);

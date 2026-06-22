import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const env = Object.fromEntries(readFileSync(B+'/shared/portal.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
const url=env.DATABASE_URL; const m=require('mysql2/promise'); const c=await m.createConnection(url);
const [[d]]=await c.query("SELECT id,original_filename,mime_type,storage_provider,storage_path,upload_status,size_bytes FROM case_documents WHERE id='670ea36f-c82f-450e-913e-6c77bb94fd1f'");
console.log('DOC:', JSON.stringify(d));
await c.end();
if(!d){console.log('no existe');process.exit(0)}
if(d.storage_provider==='r2'){
  const S3=require('@aws-sdk/client-s3'); const {S3Client,GetObjectCommand}=S3;
  const s3=new S3Client({region:'auto',endpoint:env.R2_ENDPOINT,credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY}});
  try{
    const r=await s3.send(new GetObjectCommand({Bucket:env.R2_BUCKET_PROD,Key:d.storage_path,Range:'bytes=0-7'}));
    const buf=Buffer.from(await r.Body.transformToByteArray());
    console.log('PRIMEROS BYTES:', JSON.stringify(buf.toString('latin1')), '| hex:', buf.toString('hex'), '| ContentType R2:', r.ContentType);
  }catch(e){console.log('FETCH R2 ERROR:', e.name, e.message?.slice(0,120))}
}

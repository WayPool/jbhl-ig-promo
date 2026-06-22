import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const env = Object.fromEntries(readFileSync(B+'/shared/portal.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
const acc=env.R2_ACCOUNT_ID, key=env.R2_ACCESS_KEY_ID, sec=env.R2_SECRET_ACCESS_KEY, ep=env.R2_ENDPOINT, bucket=env.R2_BUCKET_PROD;
console.log('endpoint:', ep, '| bucket:', bucket);
let S3;
try { S3 = require('@aws-sdk/client-s3'); } catch(e){ console.log('NO @aws-sdk/client-s3 en bundle:', e.message); process.exit(0); }
const { S3Client, GetBucketCorsCommand } = S3;
const c = new S3Client({ region:'auto', endpoint: ep, credentials:{ accessKeyId:key, secretAccessKey:sec } });
try {
  const r = await c.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log('CORS ACTUAL:', JSON.stringify(r.CORSRules, null, 1));
} catch(e) {
  console.log('CORS:', e.name, '-', e.message?.slice(0,120), '=> probablemente SIN CORS configurado');
}

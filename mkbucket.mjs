import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const B='/var/www/vhosts/jbhasesorialegal.com';
const require = createRequire(B+'/portal/apps/portal/server.js');
const env = Object.fromEntries(readFileSync(B+'/shared/portal.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
const S3=require('@aws-sdk/client-s3'); const {S3Client,CreateBucketCommand,HeadBucketCommand,ListBucketsCommand}=S3;
const s3=new S3Client({region:'auto',endpoint:env.R2_ENDPOINT,credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY}});
const NAME='jbh-legal-jurisprudence-prod';
try{ await s3.send(new HeadBucketCommand({Bucket:NAME})); console.log('YA EXISTE:', NAME); }
catch(e){ try{ await s3.send(new CreateBucketCommand({Bucket:NAME})); console.log('CREADO:', NAME); } catch(e2){ console.log('ERROR creando:', e2.name, e2.message?.slice(0,140)); } }
const r=await s3.send(new ListBucketsCommand({}));
console.log('buckets:', (r.Buckets||[]).map(b=>b.Name).join(', '));

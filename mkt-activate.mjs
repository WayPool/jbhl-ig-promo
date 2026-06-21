import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire('/var/www/vhosts/jbhasesorialegal.com/portal/apps/portal/server.js');
const url = readFileSync('/var/www/vhosts/jbhasesorialegal.com/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
await c.query("UPDATE marketing_settings SET audiences=? WHERE id='global'", [JSON.stringify(["cliente","abogado","perito"])]);
const [r]=await c.query("SELECT audiences,enabled_channels,auto_publish_blog FROM marketing_settings");
console.log('UPDATED', JSON.stringify(r[0]));
await c.end();

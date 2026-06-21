import { readFileSync } from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire('/var/www/vhosts/jbhasesorialegal.com/portal/apps/portal/server.js');
const url = readFileSync('/var/www/vhosts/jbhasesorialegal.com/shared/portal.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
const m = require('mysql2/promise'); const c = await m.createConnection(url);
const [r]=await c.query("SELECT daily_enabled,auto_publish_blog,auto_publish_social,enabled_channels,audiences FROM marketing_settings");
console.log('SETTINGS', JSON.stringify(r[0]));
await c.end();

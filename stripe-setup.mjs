/**
 * stripe-setup.mjs — Crea (idempotente) los productos/precios de suscripción SaaS
 * en la cuenta Stripe REAL de JBH. Usa la API REST de Stripe vía fetch (sin SDK),
 * así no depende de node_modules. Lee STRIPE_SECRET_KEY del shared env.
 *
 *   node stripe-setup.mjs --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * Imprime las 4 env vars STRIPE_PRICE_*. Idempotente (productos por metadata jbh_plan,
 * precios por lookup_key). exit 0 OK / 1 error.
 */
import { readFileSync } from 'node:fs';

function envVal(path, key) {
  const txt = readFileSync(path, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*?)\\s*$'));
    if (m) { let v = m[1].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return v; }
  }
  return null;
}

const args = process.argv.slice(2);
const envPath = args.includes('--env') ? args[args.indexOf('--env') + 1] : '/var/www/vhosts/jbhasesorialegal.com/shared/portal.env';
const KEY = envVal(envPath, 'STRIPE_SECRET_KEY');
if (!KEY) { console.log('[stripe] FATAL: falta STRIPE_SECRET_KEY en ' + envPath); process.exit(1); }
const BASE = 'https://api.stripe.com/v1';

async function sapi(method, path, params) {
  const opts = { method, headers: { Authorization: 'Bearer ' + KEY } };
  let url = BASE + path;
  if (params && method === 'GET') url += '?' + params;
  else if (params) { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = params; }
  const r = await fetch(url, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error ? j.error.message : ''}`);
  return j;
}

const PLANS = [
  { plan: 'individual', name: 'JBH Legal — Plan Individual', monthly: 37500, annual: 375000 },
  { plan: 'despacho', name: 'JBH Legal — Plan Despacho', monthly: 99500, annual: 995000 },
];

async function findOrCreateProduct(plan, name) {
  const list = await sapi('GET', '/products', 'limit=100');
  const found = (list.data || []).find((p) => p.metadata && p.metadata.jbh_plan === plan);
  if (found) { console.log(`[stripe] producto existe ${plan}: ${found.id}`); return found.id; }
  const body = new URLSearchParams({ name, 'metadata[jbh_plan]': plan }).toString();
  const p = await sapi('POST', '/products', body);
  console.log(`[stripe] producto creado ${plan}: ${p.id}`);
  return p.id;
}

async function findOrCreatePrice(productId, lookup, amount, interval) {
  const ex = await sapi('GET', '/prices', 'lookup_keys[]=' + encodeURIComponent(lookup) + '&limit=1');
  if (ex.data && ex.data.length) { console.log(`[stripe] precio existe ${lookup}: ${ex.data[0].id}`); return ex.data[0].id; }
  const body = new URLSearchParams({
    product: productId, unit_amount: String(amount), currency: 'eur',
    'recurring[interval]': interval, lookup_key: lookup,
  }).toString();
  const pr = await sapi('POST', '/prices', body);
  console.log(`[stripe] precio creado ${lookup}: ${pr.id}`);
  return pr.id;
}

(async () => {
  try {
    const acct = await sapi('GET', '/account', null);
    const mode = KEY.startsWith('sk_live') ? 'LIVE' : 'TEST';
    const display = (acct.business_profile && acct.business_profile.name) || (acct.settings && acct.settings.dashboard && acct.settings.dashboard.display_name) || '';
    console.log(`[stripe] CUENTA id=${acct.id} nombre="${display}" email=${acct.email || ''} pais=${acct.country || ''} modo=${mode}`);
    const out = {};
    for (const p of PLANS) {
      const prod = await findOrCreateProduct(p.plan, p.name);
      out[`STRIPE_PRICE_${p.plan.toUpperCase()}_MONTHLY`] = await findOrCreatePrice(prod, `jbh_${p.plan}_monthly`, p.monthly, 'month');
      out[`STRIPE_PRICE_${p.plan.toUpperCase()}_ANNUAL`] = await findOrCreatePrice(prod, `jbh_${p.plan}_annual`, p.annual, 'year');
    }
    console.log('[stripe] --- ENV VARS ---');
    for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
    console.log('[stripe] OK');
    process.exit(0);
  } catch (e) {
    console.log('[stripe] FATAL: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  }
})();

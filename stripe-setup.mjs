/**
 * stripe-setup.mjs — Crea (idempotente) los productos/precios de suscripción SaaS
 * en la cuenta Stripe REAL de JBH (lee STRIPE_SECRET_KEY del shared env del servidor).
 *
 * Ejecutar desde una app desplegada que tenga `stripe` en node_modules (p. ej. ~/portal):
 *   cd /var/www/vhosts/jbhasesorialegal.com/portal && node stripe-setup.mjs --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * Imprime las 4 env vars STRIPE_PRICE_* con los price IDs. Idempotente (reusa por
 * metadata jbh_plan en productos y por lookup_key en precios). exit 0 OK / 1 error.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

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
const key = envVal(envPath, 'STRIPE_SECRET_KEY');
if (!key) { console.log('[stripe] FATAL: falta STRIPE_SECRET_KEY en ' + envPath); process.exit(1); }

const Stripe = require('stripe');
const stripe = new Stripe(key);

// Importes en céntimos. Individual 375 €/mes (3.750 €/año = 2 meses gratis), Despacho 995 €/mes (9.950 €/año).
const PLANS = [
  { plan: 'individual', name: 'JBH Legal — Plan Individual', monthly: 37500, annual: 375000 },
  { plan: 'despacho', name: 'JBH Legal — Plan Despacho', monthly: 99500, annual: 995000 },
];

async function findOrCreateProduct(plan, name) {
  const all = await stripe.products.list({ limit: 100 });
  const found = all.data.find((p) => p.metadata && p.metadata.jbh_plan === plan);
  if (found) { console.log(`[stripe] producto existe ${plan}: ${found.id}`); return found; }
  const p = await stripe.products.create({ name, metadata: { jbh_plan: plan } });
  console.log(`[stripe] producto creado ${plan}: ${p.id}`);
  return p;
}

async function findOrCreatePrice(productId, lookup, amount, interval) {
  const ex = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 });
  if (ex.data.length) { console.log(`[stripe] precio existe ${lookup}: ${ex.data[0].id}`); return ex.data[0]; }
  const pr = await stripe.prices.create({
    product: productId, unit_amount: amount, currency: 'eur',
    recurring: { interval }, lookup_key: lookup,
  });
  console.log(`[stripe] precio creado ${lookup}: ${pr.id}`);
  return pr;
}

(async () => {
  try {
    const acct = await stripe.accounts.retrieve();
    const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
    const display = (acct.business_profile && acct.business_profile.name) || (acct.settings && acct.settings.dashboard && acct.settings.dashboard.display_name) || '';
    console.log(`[stripe] CUENTA id=${acct.id} nombre="${display}" email=${acct.email || ''} modo=${mode}`);
    const out = {};
    for (const p of PLANS) {
      const prod = await findOrCreateProduct(p.plan, p.name);
      const mo = await findOrCreatePrice(prod.id, `jbh_${p.plan}_monthly`, p.monthly, 'month');
      const an = await findOrCreatePrice(prod.id, `jbh_${p.plan}_annual`, p.annual, 'year');
      out[`STRIPE_PRICE_${p.plan.toUpperCase()}_MONTHLY`] = mo.id;
      out[`STRIPE_PRICE_${p.plan.toUpperCase()}_ANNUAL`] = an.id;
    }
    console.log('[stripe] --- ENV VARS (copiar a shared/portal.env) ---');
    for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
    console.log('[stripe] OK');
    process.exit(0);
  } catch (e) {
    console.log('[stripe] FATAL: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  }
})();

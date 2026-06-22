#!/usr/bin/env node
/**
 * fase17-perito-connect-migrate.mjs — PAGO DEL PERITAJE POR INTERMEDIACIÓN
 * (Stripe Connect · Fase 17 · P1 fundación). ADITIVA e IDEMPOTENTE.
 *
 * El CLIENTE paga el presupuesto del perito a la plataforma; la plataforma retiene
 * el 10% y abona el 90% al perito vía destination charge. ESTA migración crea SOLO
 * la FUNDACIÓN (columnas de cuenta Connect del perito + columnas de pago en el
 * presupuesto). El flujo de cobro del cliente y el bloqueo de entrega son P2.
 *
 * Qué hace, EN ORDEN, sobre dos tablas EXISTENTES:
 *
 *   professional_profiles (cuenta Connect del PERITO + estado de cobros):
 *     ADD stripe_account_id          varchar(255) NULL
 *     ADD connect_charges_enabled    tinyint      NOT NULL DEFAULT 0
 *     ADD connect_payouts_enabled    tinyint      NOT NULL DEFAULT 0
 *     ADD connect_details_submitted  tinyint      NOT NULL DEFAULT 0
 *     ADD connect_status             varchar(30)  NULL   (none|onboarding|active|restricted)
 *     ADD connect_updated_at         datetime     NULL
 *
 *   perito_presupuestos (datos de pago del presupuesto — solo se crean en P1):
 *     ADD commission_cents             int          NULL   (10% al cobrar — P2)
 *     ADD payment_status               varchar(20)  NOT NULL DEFAULT 'unpaid'  (unpaid|paid|refunded)
 *     ADD stripe_checkout_session_id   varchar(255) NULL
 *     ADD stripe_payment_intent_id     varchar(255) NULL
 *     ADD paid_at                      datetime     NULL
 *     ADD transfer_id                  varchar(255) NULL
 *
 *   VERIFICACIÓN final: todas las columnas nuevas existen en su tabla.
 *
 * ADITIVA: solo AÑADE columnas (nullables, o NOT NULL con DEFAULT) a tablas ya
 * existentes. No reescribe datos, no toca otras tablas ni el Modelo A. Las filas
 * existentes quedan con NULL / DEFAULT (payment_status='unpaid', flags=0) →
 * comportamiento equivalente al actual (ningún perito tiene cobros configurados
 * hasta que completa el onboarding de Stripe).
 *
 * IDEMPOTENCIA: antes de cada ALTER se comprueba si la columna ya existe
 * (information_schema). Si existe, se SALTA. Si el motor devuelve "Duplicate
 * column"/"already exists", también se trata como aplicado. Re-ejecutable.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (NO se ejecuta aquí; desde una app desplegada con `mysql2`):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase17-perito-connect-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` es opcional; por defecto:
 *   /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 * Del env se lee DATABASE_URL (igual que packages/db/src/client.ts).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);
let mysql;
try {
  mysql = require('mysql2/promise');
} catch {
  console.error(
    '[fase17-connect] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

const ALREADY_DONE = /Duplicate column|Duplicate key|check that column|already exists|exists/i;

function parseArgs(argv) {
  const out = { env: '/var/www/vhosts/jbhasesorialegal.com/shared/portal.env' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--env') out.env = argv[++i];
  }
  return out;
}

/** Lee DATABASE_URL de un .env (sin dependencias; soporta comillas y `export`). */
function readDatabaseUrl(envPath) {
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch (e) {
    console.error(`[fase17-connect] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
    process.exit(1);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[1].trim();
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) return v;
  }
  console.error(`[fase17-connect] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

/** Añade una columna a `table` solo si no existe. Idempotente y defensivo. */
async function addColumnIfMissing(conn, table, column, ddl) {
  const label = `ADD COLUMN ${table}.${column}`;
  if (await columnExists(conn, table, column)) {
    console.log(`[fase17-connect] SKIP  ${label} (ya existe)`);
    return;
  }
  try {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[fase17-connect] OK    ${label}`);
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[fase17-connect] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return;
    }
    console.error(`[fase17-connect] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

// Columnas a añadir, por tabla. Cada entrada: [columna, ddl].
const PROFILE_COLUMNS = [
  ['stripe_account_id', "stripe_account_id varchar(255) NULL DEFAULT NULL"],
  ['connect_charges_enabled', "connect_charges_enabled tinyint NOT NULL DEFAULT 0"],
  ['connect_payouts_enabled', "connect_payouts_enabled tinyint NOT NULL DEFAULT 0"],
  ['connect_details_submitted', "connect_details_submitted tinyint NOT NULL DEFAULT 0"],
  ['connect_status', "connect_status varchar(30) NULL DEFAULT NULL"],
  ['connect_updated_at', "connect_updated_at datetime NULL DEFAULT NULL"],
];

const PRESUPUESTO_COLUMNS = [
  ['commission_cents', "commission_cents int NULL DEFAULT NULL"],
  ['payment_status', "payment_status varchar(20) NOT NULL DEFAULT 'unpaid'"],
  ['stripe_checkout_session_id', "stripe_checkout_session_id varchar(255) NULL DEFAULT NULL"],
  ['stripe_payment_intent_id', "stripe_payment_intent_id varchar(255) NULL DEFAULT NULL"],
  ['paid_at', "paid_at datetime NULL DEFAULT NULL"],
  ['transfer_id', "transfer_id varchar(255) NULL DEFAULT NULL"],
];

async function migrateTable(conn, table, columns) {
  if (!(await tableExists(conn, table))) {
    console.error(`[fase17-connect] FATAL: la tabla ${table} no existe.`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
  for (const [column, ddl] of columns) {
    await addColumnIfMissing(conn, table, column, ddl);
  }
}

async function verifyTable(conn, table, columns) {
  let ok = true;
  for (const [column] of columns) {
    if (!(await columnExists(conn, table, column))) {
      console.error(`[fase17-connect] VERIFY FAIL: la columna ${table}.${column} no existe.`);
      ok = false;
    } else {
      console.log(`[fase17-connect] VERIFY OK: columna ${table}.${column} presente.`);
    }
  }
  return ok;
}

async function main() {
  const { env } = parseArgs(process.argv);
  const databaseUrl = readDatabaseUrl(env);

  const conn = await mysql.createConnection({
    uri: databaseUrl,
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  console.log(`[fase17-connect] Conectado. env=${env}`);

  // ── 1) professional_profiles: cuenta Connect del perito + flags de estado ─────
  await migrateTable(conn, 'professional_profiles', PROFILE_COLUMNS);
  // ── 2) perito_presupuestos: columnas de pago del presupuesto (P1 solo crea) ───
  await migrateTable(conn, 'perito_presupuestos', PRESUPUESTO_COLUMNS);

  // ── 3) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[fase17-connect] --- Verificación ---');
  const okProfile = await verifyTable(conn, 'professional_profiles', PROFILE_COLUMNS);
  const okPresupuesto = await verifyTable(conn, 'perito_presupuestos', PRESUPUESTO_COLUMNS);

  await conn.end().catch(() => {});

  if (okProfile && okPresupuesto) {
    console.log('[fase17-connect] OK Stripe Connect del perito (cuenta + pago del presupuesto)');
    process.exit(0);
  }
  console.error('[fase17-connect] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[fase17-connect] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * fase1-migrate.mjs — Migración Fase 1 (SaaS despachos) AUTOCONTENIDA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN:
 *   1. CREATE TABLE IF NOT EXISTS organization_subscriptions (SIN FK, utf8mb4).
 *      Una fila por organización (uq_org_sub_org). Modela el plan SaaS del despacho.
 *   2. VERIFICACIÓN final: la tabla `organization_subscriptions` existe.
 *
 * ADITIVA: no toca ninguna tabla existente (ni `collaborator_subscriptions`, ni
 * `case_payments`, ni el Modelo A). Solo crea una tabla nueva.
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa el patrón de
 * "ya existe" (Duplicate / exists), se LOGUEA y se continúa. Cualquier OTRO error
 * ABORTA con process.exit(1). Re-ejecutable sin efectos secundarios.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada que tenga `mysql2` en node_modules,
 * p. ej. el backend del portal; el runner resuelve mysql2 desde el cwd):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase1-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` es opcional; por defecto:
 *   /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 * Del env se lee la variable DATABASE_URL (igual que packages/db/src/client.ts).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// mysql2 se resuelve desde el cwd (node_modules de la app desplegada), NO desde
// la ubicación de este script (que vive fuera de cualquier app).
const require = createRequire(`${process.cwd()}/`);
let mysql;
try {
  mysql = require('mysql2/promise');
} catch {
  console.error(
    '[fase1] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

// Reconoce errores "ya aplicado" → idempotencia (loguear y continuar).
const ALREADY_DONE = /Duplicate column|Duplicate key|check that column|already exists|exists/i;

// ───────────────────────────────────────────────────────────────────────────
// Args / env
// ───────────────────────────────────────────────────────────────────────────
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
    console.error(`[fase1] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
    process.exit(1);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[1].trim();
    // quitar comentario inline solo si no está entre comillas
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) return v;
  }
  console.error(`[fase1] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Ejecución idempotente
// ───────────────────────────────────────────────────────────────────────────
async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[fase1] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[fase1] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[fase1] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

/** ¿Existe la tabla? (information_schema). */
async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

async function main() {
  const { env } = parseArgs(process.argv);
  const databaseUrl = readDatabaseUrl(env);

  const conn = await mysql.createConnection({
    uri: databaseUrl,
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  console.log(`[fase1] Conectado. env=${env}`);

  // ── 1) organization_subscriptions (SIN FK, idempotente) ─────────────────────
  await runIdempotent(
    conn,
    'CREATE TABLE organization_subscriptions',
    `CREATE TABLE IF NOT EXISTS organization_subscriptions (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       org_id varchar(36) NOT NULL,
       stripe_customer_id varchar(255) NULL,
       stripe_subscription_id varchar(255) NULL,
       plan varchar(20) NULL,
       period varchar(10) NULL,
       status varchar(20) NOT NULL DEFAULT 'none',
       seats_included int NULL,
       ai_quota_json json NULL,
       current_period_end datetime NULL,
       trial_ends_at datetime NULL,
       grace_until datetime NULL,
       cancel_at_period_end tinyint NOT NULL DEFAULT 0,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_org_sub_org (org_id),
       KEY idx_org_sub_status (status),
       KEY idx_org_sub_stripe_sub (stripe_subscription_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  // ── 2) VERIFICACIÓN ─────────────────────────────────────────────────────────
  console.log('[fase1] --- Verificación ---');
  let ok = true;

  if (!(await tableExists(conn, 'organization_subscriptions'))) {
    console.error('[fase1] VERIFY FAIL: la tabla organization_subscriptions no existe.');
    ok = false;
  } else {
    console.log('[fase1] VERIFY OK: tabla organization_subscriptions presente.');
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[fase1] OK organization_subscriptions');
    process.exit(0);
  }
  console.error('[fase1] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[fase1] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

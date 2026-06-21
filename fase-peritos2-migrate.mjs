#!/usr/bin/env node
/**
 * fase-peritos2-migrate.mjs — Migración FLUJO DE PERITAJE (P2) AUTOCONTENIDA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN:
 *   1. CREATE TABLE IF NOT EXISTS perito_presupuestos (presupuesto del peritaje que el
 *      perito ofrece y el abogado acepta/rechaza; tenant-owned, org_id = despacho).
 *   2. CREATE TABLE IF NOT EXISTS perito_messages (canal Q&A perito↔abogado↔cliente,
 *      acotado al hilo de un perito en un caso; tenant-owned).
 *   3. VERIFICACIÓN final: las dos tablas existen.
 *
 * ADITIVA: no toca ninguna tabla existente (ni el Modelo A). Solo crea tablas nuevas.
 * SIN FK declaradas (igual que el resto de tablas tenant-owned en prod: evita errno 150;
 * la integridad referencial se aplica en la capa de aplicación).
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa el patrón de "ya existe",
 * se LOGUEA y se continúa. Cualquier OTRO error ABORTA con process.exit(1).
 * Re-ejecutable sin efectos secundarios.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada que tenga `mysql2` en node_modules,
 * p. ej. el backend del portal; el runner resuelve mysql2 desde el cwd):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-peritos2-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` es opcional; por defecto:
 *   /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 * Del env se lee la variable DATABASE_URL (igual que packages/db/src/client.ts).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);
let mysql;
try {
  mysql = require('mysql2/promise');
} catch {
  console.error(
    '[peritos2] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
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
    console.error(`[peritos2] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[peritos2] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[peritos2] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[peritos2] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[peritos2] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

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
  console.log(`[peritos2] Conectado. env=${env}`);

  // ── 1) perito_presupuestos (tenant-owned, org_id, sin FK) ────────────────────
  await runIdempotent(
    conn,
    'CREATE TABLE perito_presupuestos',
    `CREATE TABLE IF NOT EXISTS perito_presupuestos (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       case_id varchar(36) NOT NULL,
       perito_user_id varchar(36) NOT NULL,
       org_id varchar(36) NOT NULL,
       amount_cents int NOT NULL,
       currency varchar(3) NOT NULL DEFAULT 'EUR',
       description text NULL,
       eta_days int NULL,
       status varchar(20) NOT NULL DEFAULT 'pendiente',
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       responded_at datetime NULL,
       responded_by_user_id varchar(36) NULL,
       PRIMARY KEY (id),
       KEY idx_perito_presupuestos_case (case_id),
       KEY idx_perito_presupuestos_perito (perito_user_id),
       KEY idx_perito_presupuestos_status (status)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  // ── 2) perito_messages (tenant-owned, org_id, sin FK) ────────────────────────
  await runIdempotent(
    conn,
    'CREATE TABLE perito_messages',
    `CREATE TABLE IF NOT EXISTS perito_messages (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       case_id varchar(36) NOT NULL,
       perito_user_id varchar(36) NOT NULL,
       org_id varchar(36) NOT NULL,
       sender_role varchar(20) NOT NULL,
       sender_user_id varchar(36) NULL,
       body text NOT NULL,
       audience varchar(20) NOT NULL DEFAULT 'abogado',
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       deleted_at datetime NULL,
       PRIMARY KEY (id),
       KEY idx_perito_messages_case_perito (case_id, perito_user_id),
       KEY idx_perito_messages_org (org_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  // ── 3) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[peritos2] --- Verificación ---');
  let ok = true;
  for (const t of ['perito_presupuestos', 'perito_messages']) {
    if (!(await tableExists(conn, t))) {
      console.error(`[peritos2] VERIFY FAIL: la tabla ${t} no existe.`);
      ok = false;
    } else {
      console.log(`[peritos2] VERIFY OK: tabla ${t} presente.`);
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[peritos2] OK perito_presupuestos + perito_messages');
    process.exit(0);
  }
  console.error('[peritos2] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[peritos2] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

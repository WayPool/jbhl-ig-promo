#!/usr/bin/env node
/**
 * fase-peritos3-migrate.mjs — Migración IA PERICIAL (P3) AUTOCONTENIDA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN:
 *   1. CREATE TABLE IF NOT EXISTS perito_report_drafts (borrador editable y versionado
 *      de INFORME PERICIAL asistido por IA; lo genera/edita el perito y, al finalizar,
 *      se entrega como documento del caso. Tenant-owned, org_id = despacho dueño).
 *   2. VERIFICACIÓN final: la tabla existe.
 *
 * ADITIVA: no toca ninguna tabla existente (ni el Modelo A). Solo crea una tabla nueva.
 * SIN FK declaradas (igual que el resto de tablas tenant-owned en prod: evita errno 150;
 * la integridad referencial se aplica en la capa de aplicación).
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa el patrón de "ya existe",
 * se LOGUEA y se continúa. Cualquier OTRO error ABORTA con process.exit(1).
 * Re-ejecutable sin efectos secundarios.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (NO se ejecuta aquí; desde una app desplegada con `mysql2`):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-peritos3-migrate.mjs \
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
    '[peritos3] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
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
    console.error(`[peritos3] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[peritos3] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[peritos3] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[peritos3] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[peritos3] FATAL ${label}: ${err.message}`);
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
  console.log(`[peritos3] Conectado. env=${env}`);

  // ── 1) perito_report_drafts (tenant-owned, org_id, sin FK) ───────────────────
  await runIdempotent(
    conn,
    'CREATE TABLE perito_report_drafts',
    `CREATE TABLE IF NOT EXISTS perito_report_drafts (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       case_id varchar(36) NOT NULL,
       perito_user_id varchar(36) NOT NULL,
       org_id varchar(36) NOT NULL,
       peritaje_type varchar(60) NOT NULL,
       content_markdown text NULL,
       model varchar(50) NULL,
       status varchar(20) NOT NULL DEFAULT 'ready',
       version int NOT NULL DEFAULT 1,
       generated_by_id varchar(36) NULL,
       last_edited_by_id varchar(36) NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_perito_report_drafts_org (org_id),
       KEY idx_perito_report_drafts_case (case_id),
       KEY idx_perito_report_drafts_perito (perito_user_id),
       UNIQUE KEY uq_perito_report_drafts_case_perito_type (case_id, perito_user_id, peritaje_type)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  // ── 2) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[peritos3] --- Verificación ---');
  let ok = true;
  for (const t of ['perito_report_drafts']) {
    if (!(await tableExists(conn, t))) {
      console.error(`[peritos3] VERIFY FAIL: la tabla ${t} no existe.`);
      ok = false;
    } else {
      console.log(`[peritos3] VERIFY OK: tabla ${t} presente.`);
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[peritos3] OK perito_report_drafts');
    process.exit(0);
  }
  console.error('[peritos3] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[peritos3] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

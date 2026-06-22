#!/usr/bin/env node
/**
 * fase-peritos4-migrate.mjs — IA PERICIAL (P3) · mejoras de borrador. ADITIVA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN, sobre la tabla EXISTENTE `perito_report_drafts`:
 *   1. ADD COLUMN previous_content_markdown TEXT NULL DEFAULT NULL
 *        → snapshot del contenido ANTERIOR a la última regeneración, para DESHACER
 *          (recuperable server-side, sobrevive a cambios de dispositivo).
 *   2. ADD COLUMN perito_observations TEXT NULL DEFAULT NULL
 *        → "Observaciones del perito" persistidas en BD (antes en localStorage; se
 *          perdían entre dispositivos).
 *   3. VERIFICACIÓN final: ambas columnas existen.
 *
 * ADITIVA: solo AÑADE columnas nullables con DEFAULT NULL a una tabla ya existente. No
 * reescribe datos, no toca otras tablas ni el Modelo A. Las filas existentes quedan con
 * NULL en ambas (comportamiento equivalente al actual: sin "deshacer" ni observaciones
 * previas hasta la primera regeneración/edición).
 *
 * IDEMPOTENCIA: antes de cada ALTER se comprueba si la columna ya existe
 * (information_schema). Si existe, se SALTA. Además, si el motor devuelve "Duplicate
 * column"/"already exists", también se trata como aplicado. Re-ejecutable sin efectos.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (NO se ejecuta aquí; desde una app desplegada con `mysql2`):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-peritos4-migrate.mjs \
 *        --env /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 *
 * `--env <path>` es opcional; por defecto:
 *   /var/www/vhosts/jbhasesorialegal.com/shared/portal.env
 * Del env se lee DATABASE_URL (igual que packages/db/src/client.ts).
 *
 * Requiere haber ejecutado antes `fase-peritos3-migrate.mjs` (crea la tabla).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/`);
let mysql;
try {
  mysql = require('mysql2/promise');
} catch {
  console.error(
    '[peritos4] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

const ALREADY_DONE = /Duplicate column|Duplicate key|check that column|already exists|exists/i;
const TABLE = 'perito_report_drafts';

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
    console.error(`[peritos4] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[peritos4] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
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

/** Añade una columna solo si no existe. Idempotente y defensivo. */
async function addColumnIfMissing(conn, column, ddl) {
  const label = `ADD COLUMN ${TABLE}.${column}`;
  if (await columnExists(conn, TABLE, column)) {
    console.log(`[peritos4] SKIP  ${label} (ya existe)`);
    return;
  }
  try {
    await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${ddl}`);
    console.log(`[peritos4] OK    ${label}`);
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[peritos4] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return;
    }
    console.error(`[peritos4] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

async function main() {
  const { env } = parseArgs(process.argv);
  const databaseUrl = readDatabaseUrl(env);

  const conn = await mysql.createConnection({
    uri: databaseUrl,
    charset: 'utf8mb4',
    multipleStatements: false,
  });
  console.log(`[peritos4] Conectado. env=${env}`);

  // Pre-requisito: la tabla debe existir (la crea fase-peritos3).
  if (!(await tableExists(conn, TABLE))) {
    console.error(
      `[peritos4] FATAL: la tabla ${TABLE} no existe. Ejecuta antes fase-peritos3-migrate.mjs.`,
    );
    await conn.end().catch(() => {});
    process.exit(1);
  }

  // ── 1) previous_content_markdown (deshacer regeneración) ─────────────────────
  await addColumnIfMissing(
    conn,
    'previous_content_markdown',
    'previous_content_markdown text NULL DEFAULT NULL',
  );

  // ── 2) perito_observations (observaciones persistidas en BD) ─────────────────
  await addColumnIfMissing(
    conn,
    'perito_observations',
    'perito_observations text NULL DEFAULT NULL',
  );

  // ── 3) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[peritos4] --- Verificación ---');
  let ok = true;
  for (const c of ['previous_content_markdown', 'perito_observations']) {
    if (!(await columnExists(conn, TABLE, c))) {
      console.error(`[peritos4] VERIFY FAIL: la columna ${TABLE}.${c} no existe.`);
      ok = false;
    } else {
      console.log(`[peritos4] VERIFY OK: columna ${TABLE}.${c} presente.`);
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[peritos4] OK perito_report_drafts (deshacer + observaciones)');
    process.exit(0);
  }
  console.error('[peritos4] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[peritos4] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

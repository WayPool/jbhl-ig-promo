#!/usr/bin/env node
/**
 * fase17-doc-unavailable-migrate.mjs — "No dispongo de este documento". ADITIVA e IDEMPOTENTE.
 *
 * Qué hace, EN ORDEN, sobre la tabla EXISTENTE `questionnaire_answers`:
 *   1. ADD COLUMN document_unavailable TINYINT(1) NOT NULL DEFAULT 0
 *        → el cliente DECLARA que no dispone del documento obligatorio de la pregunta.
 *   2. ADD COLUMN document_unavailable_reason VARCHAR(500) NULL DEFAULT NULL
 *        → motivo declarado por el cliente (obligatorio para usar la vía "no dispongo").
 *   3. VERIFICACIÓN final: ambas columnas existen.
 *
 * Contexto: las preguntas con documento OBLIGATORIO exigían adjuntar un fichero para
 * considerarse respondidas, bloqueando a los clientes que NO disponen del documento.
 * Estas columnas permiten una declaración explícita ("No dispongo de este documento" +
 * motivo) que cuenta como respondida y queda visible para el abogado como "Documento
 * pendiente / no aportado".
 *
 * ADITIVA: solo AÑADE columnas a una tabla ya existente. `document_unavailable` es NOT
 * NULL con DEFAULT 0 → las filas existentes quedan en 0 (comportamiento actual: sin
 * declaración). `document_unavailable_reason` es nullable. No reescribe datos ni toca
 * otras tablas.
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
 *   node /ruta/a/infra/saas-migrations/fase17-doc-unavailable-migrate.mjs \
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
    '[doc-unavail] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
      'una app desplegada que lo tenga instalado (p. ej. el backend del portal).',
  );
  process.exit(1);
}

const ALREADY_DONE = /Duplicate column|Duplicate key|check that column|already exists|exists/i;
const TABLE = 'questionnaire_answers';

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
    console.error(`[doc-unavail] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[doc-unavail] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
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
    console.log(`[doc-unavail] SKIP  ${label} (ya existe)`);
    return;
  }
  try {
    await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${ddl}`);
    console.log(`[doc-unavail] OK    ${label}`);
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[doc-unavail] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return;
    }
    console.error(`[doc-unavail] FATAL ${label}: ${err.message}`);
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
  console.log(`[doc-unavail] Conectado. env=${env}`);

  if (!(await tableExists(conn, TABLE))) {
    console.error(`[doc-unavail] FATAL: la tabla ${TABLE} no existe.`);
    await conn.end().catch(() => {});
    process.exit(1);
  }

  // ── 1) document_unavailable ──────────────────────────────────────────────────
  await addColumnIfMissing(
    conn,
    'document_unavailable',
    'document_unavailable tinyint(1) NOT NULL DEFAULT 0',
  );

  // ── 2) document_unavailable_reason ───────────────────────────────────────────
  await addColumnIfMissing(
    conn,
    'document_unavailable_reason',
    'document_unavailable_reason varchar(500) NULL DEFAULT NULL',
  );

  // ── 3) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[doc-unavail] --- Verificación ---');
  let ok = true;
  for (const c of ['document_unavailable', 'document_unavailable_reason']) {
    if (!(await columnExists(conn, TABLE, c))) {
      console.error(`[doc-unavail] VERIFY FAIL: la columna ${TABLE}.${c} no existe.`);
      ok = false;
    } else {
      console.log(`[doc-unavail] VERIFY OK: columna ${TABLE}.${c} presente.`);
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[doc-unavail] OK questionnaire_answers (no dispongo de documento)');
    process.exit(0);
  }
  console.error('[doc-unavail] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[doc-unavail] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

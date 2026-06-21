#!/usr/bin/env node
/**
 * fase-marketing-audiencias-migrate.mjs — Migración ADITIVA e IDEMPOTENTE del motor
 * de Marketing IA para soportar TRES audiencias: cliente / abogado / perito.
 *
 * Qué hace, EN ORDEN (todo ADITIVO; no toca datos existentes):
 *   1. marketing_settings.audiences  JSON NULL   → audiencias que rota el motor.
 *      Tras crearla, rellena la fila singleton ('global') con ["cliente"] SOLO si
 *      está a NULL, para PRESERVAR el comportamiento actual (solo cliente) hasta que
 *      el despacho active abogado/perito desde el admin.
 *   2. marketing_topics.audience     varchar(20) NOT NULL DEFAULT 'cliente'.
 *   3. content_pieces.audience       varchar(20) NULL DEFAULT 'cliente'.
 *   4. VERIFICACIÓN final: las tres columnas existen.
 *
 * NO la ejecutes aquí. El scheduler la corre desde una app desplegada con `mysql2`.
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa "ya existe / columna
 * duplicada", se LOGUEA y se continúa. Cualquier OTRO error ABORTA con exit(1).
 * Re-ejecutable sin efectos secundarios.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (desde una app desplegada con `mysql2`):
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-marketing-audiencias-migrate.mjs \
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
    '[mkt-aud] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
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

function readDatabaseUrl(envPath) {
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch (e) {
    console.error(`[mkt-aud] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[mkt-aud] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    await conn.query(sqlText, params);
    console.log(`[mkt-aud] OK    ${label}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[mkt-aud] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[mkt-aud] FATAL ${label}: ${err.message}`);
    await conn.end().catch(() => {});
    process.exit(1);
  }
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
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
  console.log(`[mkt-aud] Conectado. env=${env}`);

  // ── 1) marketing_settings.audiences (JSON, NULL) ─────────────────────────────
  await runIdempotent(
    conn,
    'ALTER marketing_settings ADD audiences JSON',
    `ALTER TABLE marketing_settings ADD COLUMN audiences JSON NULL AFTER enabled_channels`,
  );
  // Backfill SOLO la fila singleton a ["cliente"] si está NULL (preserva comportamiento).
  await runIdempotent(
    conn,
    "BACKFILL marketing_settings.audiences = ['cliente'] (singleton, solo si NULL)",
    `UPDATE marketing_settings SET audiences = JSON_ARRAY('cliente') WHERE id = 'global' AND audiences IS NULL`,
  );

  // ── 2) marketing_topics.audience (varchar(20) NOT NULL DEFAULT 'cliente') ─────
  await runIdempotent(
    conn,
    "ALTER marketing_topics ADD audience varchar(20) NOT NULL DEFAULT 'cliente'",
    `ALTER TABLE marketing_topics ADD COLUMN audience varchar(20) NOT NULL DEFAULT 'cliente' AFTER area`,
  );

  // ── 3) content_pieces.audience (varchar(20) NULL DEFAULT 'cliente') ───────────
  await runIdempotent(
    conn,
    "ALTER content_pieces ADD audience varchar(20) NULL DEFAULT 'cliente'",
    `ALTER TABLE content_pieces ADD COLUMN audience varchar(20) NULL DEFAULT 'cliente' AFTER target_area`,
  );

  // ── 4) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[mkt-aud] --- Verificación ---');
  let ok = true;
  const checks = [
    ['marketing_settings', 'audiences'],
    ['marketing_topics', 'audience'],
    ['content_pieces', 'audience'],
  ];
  for (const [t, c] of checks) {
    if (!(await columnExists(conn, t, c))) {
      console.error(`[mkt-aud] VERIFY FAIL: ${t}.${c} no existe.`);
      ok = false;
    } else {
      console.log(`[mkt-aud] VERIFY OK: ${t}.${c} presente.`);
    }
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[mkt-aud] OK marketing audiencias');
    process.exit(0);
  }
  console.error('[mkt-aud] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[mkt-aud] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

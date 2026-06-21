#!/usr/bin/env node
/**
 * fase-multirol-migrate.mjs — Migración MULTI-ROL (mismo email, varios roles de app)
 * AUTOCONTENIDA e IDEMPOTENTE.
 *
 * CONTEXTO: `users.email` es ÚNICO global (Auth.js exige email→1 usuario) y `users.role`
 * es un único valor, lo que impide que una MISMA persona sea, p. ej., CLIENT en el área
 * cliente Y PERITO en el área del perito a la vez. Esta migración añade, de forma ADITIVA,
 * una tabla `user_roles` con el CONJUNTO de roles de acceso de cada persona, manteniendo
 * UNA sola fila de usuario por email. La app comprueba la UNIÓN {users.role} ∪ user_roles
 * en cada puerta de entrada.
 *
 * Qué hace, EN ORDEN:
 *   1. CREATE TABLE IF NOT EXISTS user_roles (id, user_id, role, created_at). Sin FK
 *      declarada (como el resto de tablas nuevas en prod: evita errno 150; integridad
 *      en la capa de aplicación). UNIQUE (user_id, role) → idempotencia del backfill.
 *   2. BACKFILL: copia el rol canónico actual (users.role) a user_roles para cada
 *      usuario NO anonimizado que aún no lo tenga. INSERT ... SELECT ... WHERE NOT EXISTS,
 *      re-ejecutable sin duplicar (lo garantiza también el UNIQUE).
 *   3. VERIFICACIÓN: la tabla existe y todo usuario no anonimizado tiene al menos su
 *      rol canónico reflejado en user_roles.
 *
 * ADITIVA: NO modifica `users` (ni el UNIQUE de email, ni la columna role), ni el
 * Modelo A. Un usuario mono-rol sigue entrando igual: la lógica de la app cae a
 * `users.role` aunque no existiera fila en user_roles (el backfill solo uniformiza).
 *
 * IDEMPOTENCIA: cada sentencia se ejecuta y, si el error casa "ya existe", se LOGUEA y
 * se continúa. Cualquier OTRO error ABORTA con process.exit(1). Re-ejecutable.
 *
 * EXIT CODE = única señal fiable para el scheduler: 0 = OK, 1 = fallo.
 *
 * CÓMO EJECUTARLO (NO se ejecuta aquí; desde una app desplegada con `mysql2`):
 *
 *   cd /var/www/vhosts/jbhasesorialegal.com/<app-con-mysql2>
 *   node /ruta/a/infra/saas-migrations/fase-multirol-migrate.mjs \
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
    '[multirol] ERROR: no se encontró `mysql2` en el cwd. Ejecútalo con `cd` dentro de ' +
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
    console.error(`[multirol] ERROR: no se pudo leer el env "${envPath}": ${e.message}`);
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
  console.error(`[multirol] ERROR: DATABASE_URL no encontrada en "${envPath}".`);
  process.exit(1);
}

async function runIdempotent(conn, label, sqlText, params = []) {
  try {
    const [res] = await conn.query(sqlText, params);
    const affected = res && typeof res.affectedRows === 'number' ? ` (filas: ${res.affectedRows})` : '';
    console.log(`[multirol] OK    ${label}${affected}`);
    return 'applied';
  } catch (err) {
    if (ALREADY_DONE.test(err.message || '')) {
      console.log(`[multirol] SKIP  ${label} (ya aplicado: ${err.code || err.message})`);
      return 'skipped';
    }
    console.error(`[multirol] FATAL ${label}: ${err.message}`);
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
  console.log(`[multirol] Conectado. env=${env}`);

  // ── 1) CREATE TABLE user_roles (aditiva, sin FK declarada) ───────────────────
  await runIdempotent(
    conn,
    'CREATE TABLE user_roles',
    `CREATE TABLE IF NOT EXISTS user_roles (
       id varchar(36) NOT NULL DEFAULT (UUID()),
       user_id varchar(36) NOT NULL,
       role varchar(20) NOT NULL,
       created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_user_roles_user_role (user_id, role),
       KEY idx_user_roles_user (user_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );

  // ── 2) BACKFILL: rol canónico actual → user_roles (idempotente) ──────────────
  // Inserta, para cada usuario no anonimizado, su users.role si aún no está en
  // user_roles. El NOT EXISTS + UNIQUE hace que re-ejecutar no duplique.
  await runIdempotent(
    conn,
    'BACKFILL user_roles desde users.role',
    `INSERT INTO user_roles (user_id, role)
       SELECT u.id, u.role
         FROM users u
        WHERE u.role IS NOT NULL
          AND u.role <> 'ANONYMIZED'
          AND NOT EXISTS (
            SELECT 1 FROM user_roles ur
             WHERE ur.user_id = u.id AND ur.role = u.role
          )`,
  );

  // ── 3) VERIFICACIÓN ──────────────────────────────────────────────────────────
  console.log('[multirol] --- Verificación ---');
  let ok = true;

  if (!(await tableExists(conn, 'user_roles'))) {
    console.error('[multirol] VERIFY FAIL: la tabla user_roles no existe.');
    ok = false;
  } else {
    console.log('[multirol] VERIFY OK: tabla user_roles presente.');
  }

  // Todo usuario no anonimizado debe tener al menos su rol canónico en user_roles.
  const [missing] = await conn.query(
    `SELECT COUNT(*) AS n
       FROM users u
      WHERE u.role IS NOT NULL
        AND u.role <> 'ANONYMIZED'
        AND NOT EXISTS (
          SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = u.role
        )`,
  );
  const n = Number(missing[0]?.n ?? 0);
  if (n > 0) {
    console.error(`[multirol] VERIFY FAIL: ${n} usuario(s) sin su rol canónico en user_roles.`);
    ok = false;
  } else {
    console.log('[multirol] VERIFY OK: todos los usuarios no anonimizados tienen su rol canónico.');
  }

  await conn.end().catch(() => {});

  if (ok) {
    console.log('[multirol] OK user_roles + backfill');
    process.exit(0);
  }
  console.error('[multirol] VERIFICACIÓN FALLIDA. Revisa los mensajes anteriores.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`[multirol] FATAL inesperado: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

#!/bin/bash
P=/var/www/vhosts/jbhasesorialegal.com/shared
LOG=/var/www/vhosts/jbhasesorialegal.com/web/apps/web/.next/static/_e.txt
V=$(grep '^SIGNING_JWT_SECRET=' "$P/firmas.env" 2>/dev/null | head -1 | cut -d= -f2-)
[ -z "$V" ] && V=$(grep '^SIGNING_JWT_SECRET=' "$P/portal.env" 2>/dev/null | head -1 | cut -d= -f2-)
if [ -n "$V" ]; then grep -q '^SIGNING_JWT_SECRET=' "$P/cliente.env" 2>/dev/null || printf 'SIGNING_JWT_SECRET=%s\n' "$V" >> "$P/cliente.env"; fi
FU=$(grep '^FIRMAS_URL=' "$P/portal.env" 2>/dev/null | head -1 | cut -d= -f2-)
[ -n "$FU" ] && { grep -q '^FIRMAS_URL=' "$P/cliente.env" 2>/dev/null || printf 'FIRMAS_URL=%s\n' "$FU" >> "$P/cliente.env"; }
CV=$(grep '^SIGNING_JWT_SECRET=' "$P/cliente.env" 2>/dev/null | head -1 | cut -d= -f2-)
echo "SIGNING_count=$(grep -c '^SIGNING_JWT_SECRET=' "$P/cliente.env" 2>/dev/null) FIRMAS_URL_count=$(grep -c '^FIRMAS_URL=' "$P/cliente.env" 2>/dev/null) match=$([ -n "$V" ] && [ "$V" = "$CV" ] && echo YES || echo NO)" > "$LOG" 2>&1

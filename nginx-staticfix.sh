#!/bin/bash
CONF=/var/www/vhosts/system/jbhasesorialegal.com/conf/vhost_nginx.conf
HTTPDMNG=/usr/local/psa/admin/sbin/httpdmng
touch "$CONF" || exit 90
cp -a "$CONF" "${CONF}.bak.staticfix" || exit 90
if ! grep -q "_next/static/" "$CONF"; then
cat >> "$CONF" <<'NGINX'

# Servir /_next/static directamente desde disco (evita el doble-decode del proxy a Node
# que rompía los chunks de rutas dinámicas [slug] -> 404). Mas rapido ademas.
location ^~ /_next/static/ {
    alias /var/www/vhosts/jbhasesorialegal.com/web/apps/web/.next/static/;
    expires 365d;
    add_header Cache-Control "public, immutable";
    access_log off;
}
NGINX
fi
if "$HTTPDMNG" --reconfigure-domain jbhasesorialegal.com; then
    exit 0
else
    cp -a "${CONF}.bak.staticfix" "$CONF"
    "$HTTPDMNG" --reconfigure-domain jbhasesorialegal.com
    exit 91
fi

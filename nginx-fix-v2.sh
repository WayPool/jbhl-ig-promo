#!/bin/bash
CONF=/var/www/vhosts/system/jbhasesorialegal.com/conf/vhost_nginx.conf
HTTPDMNG=/usr/local/psa/admin/sbin/httpdmng
ST=/var/www/vhosts/jbhasesorialegal.com/web/apps/web/.next/static
F=$(ls "$ST/chunks/app/(corporate)/insights/[slug]/" 2>/dev/null | grep -E '^page-.*\.js$' | head -1)
[ -z "$F" ] && exit 60
URL="/_next/static/chunks/app/(corporate)/insights/%5Bslug%5D/$F"
test_local(){ curl -sk -o /dev/null -w '%{http_code}' --path-as-is --resolve jbhasesorialegal.com:443:127.0.0.1 "https://jbhasesorialegal.com$1"; }
BEFORE=$(test_local "$URL")
touch "$CONF"; cp -a "$CONF" "$CONF.bak.sf2"
if ! grep -q "apps/web/.next/static" "$CONF"; then
cat >> "$CONF" <<'NGINX'
location ^~ /_next/static/ {
    alias /var/www/vhosts/jbhasesorialegal.com/web/apps/web/.next/static/;
    expires 365d;
    add_header Cache-Control "public, immutable";
    access_log off;
}
NGINX
fi
if ! "$HTTPDMNG" --reconfigure-domain jbhasesorialegal.com >/dev/null 2>&1; then
  cp -a "$CONF.bak.sf2" "$CONF"; "$HTTPDMNG" --reconfigure-domain jbhasesorialegal.com >/dev/null 2>&1
  exit 91
fi
sleep 2
AFTER=$(test_local "$URL")
# control: home local
HOME=$(curl -sk -o /dev/null -w '%{http_code}' --resolve jbhasesorialegal.com:443:127.0.0.1 "https://jbhasesorialegal.com/")
if [ "$AFTER" = "200" ] && [ "$HOME" = "200" ]; then
  exit 0   # FIX OK (chunk sirve y home sigue bien)
fi
# no funcionó o rompió algo -> revertir
cp -a "$CONF.bak.sf2" "$CONF"; "$HTTPDMNG" --reconfigure-domain jbhasesorialegal.com >/dev/null 2>&1
[ "$AFTER" = "200" ] || exit 70   # chunk seguía 404
exit 71                            # home se rompió (revertido)

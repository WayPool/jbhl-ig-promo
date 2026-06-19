#!/bin/bash
ST=/var/www/vhosts/jbhasesorialegal.com/web/apps/web/.next/static
CONF=/var/www/vhosts/system/jbhasesorialegal.com/conf/vhost_nginx.conf
CH='/_next/static/chunks/app/(corporate)/insights/%5Bslug%5D'
# encontrar un chunk real de insights/[slug] en disco
F=$(ls "$ST/chunks/app/(corporate)/insights/[slug]/" 2>/dev/null | grep -E '^page-.*\.js$' | head -1)
OUT=$ST/diag2.txt
{
echo "===FILE_ON_DISK==="; echo "$F"
echo "===ORIGIN_LOCALHOST_TEST (bracket chunk, sin Cloudflare)==="
curl -s -o /dev/null -w "encoded %%5B -> %{http_code}\n" --path-as-is -H "Host: jbhasesorialegal.com" "http://127.0.0.1/${CH}/${F}" 2>&1
curl -s -o /dev/null -w "literal [slug] -> %{http_code}\n" -g --path-as-is -H "Host: jbhasesorialegal.com" "http://127.0.0.1/_next/static/chunks/app/(corporate)/insights/[slug]/${F}" 2>&1
echo "===VHOST_NGINX_CONF tiene mi alias?==="; grep -c "apps/web/.next/static" "$CONF" 2>&1
echo "===CONF CONTENT==="; cat "$CONF" 2>&1
echo "===NGINX GEN CONF DEL DOMINIO (grep _next)==="
grep -rn "_next" /var/www/vhosts/system/jbhasesorialegal.com/conf/*nginx* 2>/dev/null | head
echo "===NGINX -t==="; nginx -t 2>&1 | head -3
} > "$OUT" 2>&1
chmod 644 "$OUT"

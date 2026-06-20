#!/bin/bash
set -e
APP=/var/www/vhosts/jbhasesorialegal.com/firmas/apps/firmas
[ -d "$APP/.next" ] || exit 60
H1="Authorization: Bearer $1"; H2="Accept: application/vnd.github.raw"
B=https://api.github.com/repos/WayPool/jbhl-web-deploy-tmp7/contents
cd "$APP"
curl -fsSL -H "$H1" -H "$H2" -o /tmp/firmas-next.tgz "$B/firmas-next.tgz"
rm -rf .next.new && mkdir .next.new && tar xzf /tmp/firmas-next.tgz -C .next.new
test -f .next.new/BUILD_ID && test -d .next.new/server
rm -rf .next.bak.firmas && mv .next .next.bak.firmas && mv .next.new .next
export PATH=/opt/plesk/node/22/bin:$PATH
~/.npm-global/bin/pm2 reload jbhlegal-firmas --update-env
echo "FIRMAS_DONE $(cat .next/BUILD_ID)"

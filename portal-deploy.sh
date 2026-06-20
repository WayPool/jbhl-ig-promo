#!/bin/bash
set -e
APP=/var/www/vhosts/jbhasesorialegal.com/portal/apps/portal
[ -d "$APP/.next" ] || exit 60
H1="Authorization: Bearer $1"; H2="Accept: application/vnd.github.raw"
B=https://api.github.com/repos/WayPool/jbhl-web-deploy-tmp7/contents
cd "$APP"
curl -fsSL -H "$H1" -H "$H2" -o /tmp/portal-next.tgz "$B/portal-next.tgz"
rm -rf .next.new && mkdir .next.new && tar xzf /tmp/portal-next.tgz -C .next.new
test -f .next.new/BUILD_ID && test -d .next.new/server
rm -rf .next.bak.portal && mv .next .next.bak.portal && mv .next.new .next
export PATH=/opt/plesk/node/22/bin:$PATH
~/.npm-global/bin/pm2 reload jbhlegal-portal --update-env
echo "PORTAL_DONE $(cat .next/BUILD_ID)"

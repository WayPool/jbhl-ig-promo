#!/bin/bash
set -e
APP=/var/www/vhosts/jbhasesorialegal.com/ai-worker
[ -d "$APP" ] || exit 60
H1="Authorization: Bearer $1"; H2="Accept: application/vnd.github.raw"
B=https://api.github.com/repos/WayPool/jbhl-web-deploy-tmp7/contents
cd "$APP"
curl -fsSL -H "$H1" -H "$H2" -o /tmp/aiworker.tgz "$B/aiworker-dist.tgz"
rm -rf dist.new && mkdir dist.new && tar xzf /tmp/aiworker.tgz -C dist.new
test -f dist.new/server.js
rm -rf dist.bak && mv dist dist.bak && mv dist.new dist
export PATH=/opt/plesk/node/22/bin:$PATH
~/.npm-global/bin/pm2 reload jbhlegal-ai-worker --update-env
echo "AIWORKER_DONE $(~/.npm-global/bin/pm2 jlist | python3 -c "import sys,json;[print(p['name'],p['pm2_env']['status']) for p in json.load(sys.stdin) if p['name']=='jbhlegal-ai-worker']" 2>/dev/null)"

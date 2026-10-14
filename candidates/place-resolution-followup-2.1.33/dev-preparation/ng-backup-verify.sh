#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
state=/home/ubuntu/.itpay-deploy/ng-20261002-dbf84ec
old=/home/ubuntu/compose
mkdir -p "$state"
chmod 700 "$state"
if [ -e "$state/backup-verified" ]; then cat "$state/backup-verified"; exit; fi
if [ ! -e "$state/itpay-v3.dump" ]; then
docker inspect itpay-v3-next-backend-1 itpay-v3-next-backend-worker-1 itpay-v3-next-rail-planner-1 > "$state/old-runtime.private.json"
docker exec itpay-v3-next-db-1 sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$state/itpay-v3.dump"
docker exec itpay-v3-next-oauth-db-1 sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$state/oauth.dump"
sha256sum "$state/itpay-v3.dump" "$state/oauth.dump" > "$state/backups.sha256"
docker exec -i itpay-v3-next-db-1 sh -ec 'psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < "$old/scripts/v3/schema-fingerprint.sql" > "$state/source-schema-set.sha256"
fi
sha256sum --quiet -c "$state/backups.sha256"
restore=itpay-ng-restore-check-20261002
[ -z "$(docker ps -aq --filter name="^${restore}$")" ]
docker run -d --rm --network none --name "$restore" -e POSTGRES_USER=itpay -e POSTGRES_DB=restore_check -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg16 >/dev/null
trap 'docker rm -f "$restore" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do docker exec "$restore" pg_isready -U itpay -d restore_check >/dev/null 2>&1 && break; sleep 1; done
docker exec -i "$restore" pg_restore -U itpay -d restore_check --exit-on-error < "$state/itpay-v3.dump" > "$state/restore-check.log" 2>&1
docker exec -i "$restore" psql -X -qAt -U itpay -d restore_check -v ON_ERROR_STOP=1 < "$old/scripts/v3/schema-fingerprint.sql" > "$state/restored-schema-set.sha256"
cmp "$state/source-schema-set.sha256" "$state/restored-schema-set.sha256"
docker exec "$restore" psql -X -q -U itpay -d restore_check -v ON_ERROR_STOP=1 -c "CREATE ROLE hydra;"
docker exec "$restore" createdb -U itpay oauth_restore_check
docker exec -i "$restore" pg_restore -U itpay -d oauth_restore_check --exit-on-error < "$state/oauth.dump" >> "$state/restore-check.log" 2>&1
printf 'backup=created; main_db_restore=pass; oauth_restore=pass; structural_fingerprint=same\n' > "$state/backup-verified"
cat "$state/backup-verified"
stat -c '%n %s bytes %a' "$state/itpay-v3.dump" "$state/oauth.dump"

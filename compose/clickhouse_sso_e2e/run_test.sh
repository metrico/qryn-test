docker compose -f test/e2e/compose/clickhouse_sso_e2e/docker-compose.yaml up -d && \
sleep 5 && \
docker run -it \
  --network clickhouse_sso_e2e_qryn-e2e \
  -v `pwd`:/qryn \
  -e 'INTEGRATION_E2E=1' \
  -e 'CLOKI_EXT_URL=qryn:3100' \
  -e 'QRYN_LOGIN=a' \
  -e 'QRYN_PASSWORD=b' \
  -e 'OTEL_COLLECTOR_URL=http://otel-collector:8062' \
  node:${NODE_VERSION} sh -c 'cd /qryn && npm install && npm run test';
code=$?;
docker compose -f test/e2e/compose/clickhouse_sso_e2e/docker-compose.yaml down;
exit $code
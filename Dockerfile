FROM mongodb/mongodb-community-server:8.0-ubuntu2204 AS mongo-tools
USER root
RUN mkdir -p /mongo-libs \
    && for lib in libgssapi_krb5.so.2 libkrb5.so.3 libk5crypto.so.3 libkrb5support.so.0 libkeyutils.so.1; do \
        source_path="$(find /lib /usr/lib -name "$lib" -print -quit)"; \
        test -n "$source_path"; \
        cp -L "$source_path" "/mongo-libs/$lib"; \
    done

FROM node:22-bookworm-slim

COPY --from=mongo-tools /usr/bin/mongodump /usr/local/bin/mongodump
COPY --from=mongo-tools /usr/bin/mongorestore /usr/local/bin/mongorestore
COPY --from=mongo-tools /mongo-libs /opt/mongo-libs
COPY --from=mongo-tools /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app.js ./app.js
COPY src ./src
COPY public ./public

RUN mkdir -p /data/backups /data/work \
    && chown -R node:node /app /data

ENV NODE_ENV=production \
    PORT=7480 \
    DATA_DIR=/data \
    BACKUP_DIR=/data/backups \
    LD_LIBRARY_PATH=/opt/mongo-libs

USER node
EXPOSE 7480
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:7480/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "app.js"]

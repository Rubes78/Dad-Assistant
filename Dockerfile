FROM node:22-alpine
RUN apk add --no-cache curl jq openssh-client bash
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
COPY tools.js .
COPY audit.js .
COPY notify.js .
COPY backup.js .
COPY runbooks.js .
COPY healthcheck.js .
COPY config.js .
COPY setup.js .
COPY onboard.js .
COPY public/ public/
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Bake defaults into /app/defaults/ — entrypoint copies them to the
# data volume on first run so users get working files out of the box
RUN mkdir -p /app/defaults/runbooks /app/data /app/runbooks
COPY CLAUDE.md /app/defaults/CLAUDE.md
COPY runbooks/ /app/defaults/runbooks/

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]

FROM node:22-alpine
RUN apk add --no-cache curl jq openssh-client bash
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
COPY tools.js .
COPY public/ public/
COPY CLAUDE.md .
RUN mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "server.js"]

FROM node:22-alpine
RUN apk add --no-cache curl jq openssh-client bash
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
COPY tools.js .
COPY public/ public/
COPY CLAUDE.md .
EXPOSE 3000
CMD ["node", "server.js"]

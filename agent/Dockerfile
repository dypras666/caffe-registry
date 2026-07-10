FROM node:20-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY agent.js .

CMD ["node", "agent.js"]

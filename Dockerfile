FROM node:22-slim
WORKDIR /app
# sharp needs these on slim
RUN apt-get update && apt-get install -y --no-install-recommends libvips42 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 5000
CMD ["npm", "run", "start"]

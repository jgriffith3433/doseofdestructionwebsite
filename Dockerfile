FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js tsconfig.json ./
COPY Game/ Game/
COPY src/ src/
COPY content/ content/
COPY tools/ tools/
RUN npm test && npm run build

FROM nginx:alpine AS development

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]

FROM development AS production

COPY index.html characters.html privacypolicy.html favicon.svg /usr/share/nginx/html/
COPY site/ /usr/share/nginx/html/site/
COPY characters/ /usr/share/nginx/html/characters/
COPY audio/ /usr/share/nginx/html/audio/
COPY --from=build /app/dist/ /usr/share/nginx/html/

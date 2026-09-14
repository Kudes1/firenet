FROM node:22-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci

# dev: Vite dev server с прокси /api на backend — браузер остаётся на одном
# origin, поэтому cookie-сессия работает без CORS.
FROM deps AS dev
# Исходники нужны и здесь: compose монтирует только ./frontend/src поверх,
# а index.html / vite.config.ts / public/* берутся из образа. Без COPY . .
# Vite не находит точку входа и отвечает 404 на /.
COPY . .
# Читается vite.config.ts: таргет прокси /api.
ENV VITE_API_TARGET=http://backend:8787
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

FROM deps AS build
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /src/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

FROM deps AS test
COPY . .
CMD ["sh", "-c", "npm run typecheck && npm test"]

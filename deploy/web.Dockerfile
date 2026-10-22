FROM node:26.11.1-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN HUSKY=0 npm ci
COPY web/ ./
RUN npm run build

FROM nginx:1.30.6-alpine@sha256:c59d1f8b1e0e42da75be973424cd72e23f7f8adfb54e982f4d1cd0216a5a5576
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/web/dist/ /usr/share/nginx/html/
EXPOSE 8080

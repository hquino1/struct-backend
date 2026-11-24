# Builds the frontend's static files without needing Node on the host:
#   docker build -f frontend-build.Dockerfile --output type=local,dest=site <frontend folder>
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_COGNITO_USER_POOL_ID
ARG VITE_COGNITO_CLIENT_ID
# Same origin as the site: CloudFront routes /api/* to the backend.
ENV VITE_API_URL=/api \
    VITE_COGNITO_USER_POOL_ID=$VITE_COGNITO_USER_POOL_ID \
    VITE_COGNITO_CLIENT_ID=$VITE_COGNITO_CLIENT_ID
RUN npm run build

FROM scratch
COPY --from=build /app/.output/public /

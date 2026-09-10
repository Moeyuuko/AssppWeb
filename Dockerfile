# Compile the emulator from a fixed upstream revision. This SDK publishes an
# amd64 image; the generated WASM works on both target architectures.
FROM --platform=linux/amd64 emscripten/emsdk:3.1.61@sha256:30aa9fed39cc7810cc4338c77828bd513a6ee6b60c6b141bc6d9760aea5791e3 AS sap-engine
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config
WORKDIR /build
RUN git clone https://github.com/alexaltea/unicorn.js.git source \
    && cd source \
    && git checkout 1220477c7fb0f8fe4b500f4bd211de52f6dfe638 \
    && git submodule update --init
COPY tools/sap-engine/build.py /build/build.py
COPY tools/sap-engine/prepare-tci.py /build/prepare-tci.py
RUN python3 /build/build.py

# Public Apple components are fetched and verified during image construction.
# There is no runtime download/extraction API or third-party signing service.
FROM --platform=$BUILDPLATFORM python:3.12-slim AS sap-assets
WORKDIR /source
COPY tools/sap-engine/extract-assets.py tools/sap-engine/extract-assets.py
COPY frontend/src/apple/sap/asset-manifest.json frontend/src/apple/sap/asset-manifest.json
RUN python3 tools/sap-engine/extract-assets.py /out

# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY --from=sap-engine /out/ ./public/sap-engine/
COPY --from=sap-assets /out/ ./public/sap-assets/
RUN npm run build

# Stage 2: Build backend
FROM node:20-alpine AS backend-build
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Stage 3: Runtime
FROM node:20-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/package.json ./
COPY --from=frontend-build /app/frontend/dist ./public
COPY tools/sap-engine/NOTICE.txt ./public/sap-engine/NOTICE.txt
RUN mkdir -p /data/packages
EXPOSE 8080
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV DATA_DIR=/data PORT=8080 BUILD_COMMIT=$BUILD_COMMIT BUILD_DATE=$BUILD_DATE
CMD ["node", "dist/index.js"]

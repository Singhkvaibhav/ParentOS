# Builds the SPA to static files. Nothing serves them from this image.
#
# The previous version shipped `serve` (a Node HTTP server) to host static
# assets, which meant a second Node process, a second thing to patch, and a
# second place TLS and caching rules could disagree with the proxy. Since
# nginx is already the entry point, the built assets are copied into it
# instead and this image only produces them.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# The API base URL is baked in at build time by Vite, so it has to be a
# build arg rather than a runtime env var. Defaults to a relative path,
# which is correct behind the reverse proxy: same origin, so the session
# cookie is first-party.
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

# --- Static output --------------------------------------------------------
# A minimal final stage holding only the built assets, so they can be
# copied into the nginx image (or an object store / CDN) without dragging
# node_modules along.
FROM scratch AS dist
COPY --from=build /app/dist /dist

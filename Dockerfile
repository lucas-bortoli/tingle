# syntax = docker/dockerfile:1

ARG NODE_VERSION=26.0.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

WORKDIR /app

ENV NODE_ENV="production"

# Build stage: compilers live here only and never reach the final image
FROM base AS build

# Uncomment when a dependency needs compiling:
# RUN apt-get update -qq && \
#     apt-get install --no-install-recommends -y build-essential pkg-config python-is-python3 && \
#     rm -rf /var/lib/apt/lists /var/cache/apt/archives

COPY package-lock.json package.json ./
# Drop only the husky "prepare" hook; dependency install scripts still run
RUN npm pkg delete scripts.prepare && npm ci --omit=dev

# Final stage for app image
FROM base

COPY --from=build /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

CMD [ "npm", "run", "start" ]

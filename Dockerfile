# HF Docker Space image: builds the explorer + space workspaces and serves both
# from a single Node process on port 7860.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY space/package.json space/
COPY explorer/package.json explorer/
COPY setup/package.json setup/
# HF's Linux builder can miss this optional native package; install the matching
# binary explicitly so Tailwind/Vite can load lightningcss during the build.
RUN npm ci && node -e "const fs=require('fs'); const {execFileSync}=require('child_process'); const version=JSON.parse(fs.readFileSync('node_modules/lightningcss/package.json','utf8')).version; const arch=process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined; if (arch === undefined) throw new Error('unsupported arch: '+process.arch); execFileSync('npm',['install','--no-save','lightningcss-linux-'+arch+'-gnu@'+version],{stdio:'inherit'});"
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY space/ space/
COPY explorer/ explorer/
RUN npm run build --workspace explorer && npx tsc --build shared space

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY space/package.json space/
COPY explorer/package.json explorer/
COPY setup/package.json setup/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/space/dist space/dist
COPY --from=build /app/explorer/dist explorer/dist
# HF Spaces run the container as user 1000 with an ephemeral, writable /data.
RUN mkdir -p /app/.data && chown -R 1000:1000 /app
USER 1000
ENV PORT=7860 DATA_DIR=/app/.data STATIC_ROOT=explorer/dist
EXPOSE 7860
CMD ["node", "space/dist/src/server.js"]

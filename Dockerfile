FROM apify/actor-node:22

COPY --chown=myuser:myuser package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=myuser:myuser src/ ./src/

CMD ["npm", "start", "--silent"]

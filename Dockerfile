FROM node:24-alpine3.22

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# ENV NODE_ENV=production
# ENV MONGODB_URI=mongodb://localhost:27017

# CMD ["sh", "-c", "if [ -z \"$MONGODB_URI\" ]; then echo 'MONGODB_URI is required'; exit 1; fi; node json_processor.js ./full_emr_clean.json smartclinic"]
CMD ["node", "json_processor.js", "./full_emr_clean.json", "smartclinic"]
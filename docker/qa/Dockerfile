FROM node:22-alpine

WORKDIR /workspace

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY react-app/package*.json ./react-app/
RUN npm ci

COPY . .

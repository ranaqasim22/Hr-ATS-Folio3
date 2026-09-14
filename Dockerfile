# --- STAGE 1: Build the Application ---
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files to install dependencies
COPY package*.json ./
RUN npm ci --legacy-peer-deps


# Copy the rest of your application code
COPY . .

# Build the TypeScript project (generates the dist folder)
RUN npm run build

# Prune development dependencies to keep the final image light
RUN npm prune --production


# --- STAGE 2: Run the Application ---
FROM node:20-alpine AS runner

WORKDIR /app

# Set Node environment to production
ENV NODE_ENV=production

# Copy only the compiled code and production modules from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Expose the default port for NestJS (change to 5000 if your app uses that)
EXPOSE 3000

# Start the application using the compiled main file
CMD ["node", "dist/main"]

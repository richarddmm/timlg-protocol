FROM node:20-slim

# Install essentials + curl for Solana CLI
RUN apt-get update && apt-get install -y curl bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Solana CLI
RUN sh -c "$(curl -sSfL https://release.solana.com/v1.18.4/install)"
ENV PATH="/root/.local/share/solana/install/active_release/bin:$PATH"

WORKDIR /app

# Copy package info first for caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY . .

# Remove hardcoded local paths from .env so docker -e takes precedence
RUN sed -i '/ORACLE_KEYPAIR/d' .env || true
RUN sed -i '/ADMIN_KEYPAIR/d' .env || true
RUN sed -i '/RELAYER_KEYPAIR/d' .env || true

# Environment variables should be passed via docker run -e
# CMD to start the supervisor
CMD ["bash", "oracle/run_operator_supervisor_devnet.sh"]

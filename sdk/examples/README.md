# TIMLG SDK Examples

## Ticket Manager (`ticket-manager.mjs`)
This is a professional reference implementation of a ticket manager that automates the full protocol lifecycle:
- **Commit**: Automatic betting with round awareness.
- **Reveal**: Grouped reveals with oracle pulse detection.
- **Claim/Refund**: Automatic reward collection and rent recovery.

### Usage
```bash
cp ticket-manager.env.example .env
# Edit .env and run:
node ticket-manager.mjs --action=all --daemon=60
```

## Oracle Node (`oracle-node.mjs`)
A reference implementation for decentralized oracle nodes:
- **Watch**: Monitors rounds and fetches NIST pulses.
- **Sign**: Automatically publishes signed pulses to the blockchain.
- **Status**: Diagnostic CLI to check protocol health.

### Usage
```bash
cp oracle-node.env.example .env
# Edit .env and run:
node oracle-node.mjs --action=watch
```

### Global Setup
1. **Install SDK dependencies**:
   ```bash
   cd .. # go to sdk root
   npm install
   npm run build
   cd examples
   ```
2. **Configure environment**:
   Create a `.env` file in the examples directory based on the examples provided.

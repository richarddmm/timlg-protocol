# TIMLG SDK Examples

## Ticket Manager (`ticket-manager.mjs`)
This is a professional reference implementation of a ticket manager that automates the full protocol lifecycle:
- **Commit**: Automatic betting with round awareness.
- **Reveal**: Grouped reveals with oracle pulse detection.
- **Claim/Refund**: Automatic reward collection and rent recovery.

### Quick Start
1. **Install dependencies**:
   ```bash
   cd .. # go to sdk root
   npm install
   npm run build
   cd examples
   ```
2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your wallet path
   ```
3. **Run**:
   ```bash
   # Full lifecycle in daemon mode
   node ticket-manager.mjs --action=all --daemon=60
   ```

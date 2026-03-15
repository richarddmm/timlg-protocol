# TIMLG SDK Examples

## Ticket Manager (`ticket-manager.mjs`)
This is a professional reference implementation of a ticket manager that automates the full protocol lifecycle:
- **Commit**: Automatic betting with round awareness.
- **Reveal**: Grouped reveals with oracle pulse detection.
- **Claim/Refund**: Automatic reward collection and rent recovery.

### Usage
1. Configure your `.env` file.
2. Run with Node.js:
   ```bash
   # Execute specific actions
   node ticket-manager.mjs --action=commit,reveal,stats
   
   # Run full lifecycle in daemon mode
   node ticket-manager.mjs --action=all --daemon=60
   ```

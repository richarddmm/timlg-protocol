# TIMLG Protocol TypeScript SDK

SDK profesional para interactuar con el protocolo TIMLG en Solana. Diseñado para ser modular, seguro y fácil de usar tanto por jugadores como por operadores de infraestructura.

## Instalación

```bash
npm install @timlg/sdk
```

## Guía Rápida y Ejemplos

Para ver implementaciones completas y profesionales, consulta nuestra carpeta de [examples/](https://github.com/richarddmm/timlg-protocol/tree/main/sdk/examples):
- **`player_demo.ts`**: Ciclo completo de juego (Apostar -> Revelar -> Cobrar).
- **`operator_demo.ts`**: Gestión automatizada de rondas para operadores.

## Estructura Modular (Roles)

El SDK se divide en tres herramientas principales dependiendo de tu rol en el protocolo:

### 1. TimlgPlayer (Para Usuarios y Bots de Juego)
Ideal para crear gestores de tickets o aplicaciones de usuario.
```typescript
import { TimlgPlayer } from '@timlg/sdk';

const player = new TimlgPlayer(program); // program es un anchor.Program

// Apostar en una ronda
const { signature, receipt } = await player.commit(roundId, guess, {
  timlgMint,
  userTimlgAta
});

// Revelar (después de que cierre el commit)
await player.reveal(receipt);

// Cobrar premios
await player.claim(receipt, { timlgMint, userTimlgAta });

// Cerrar cuenta de ticket (recuperar SOL de renta)
await player.closeTicket(receipt);
```

### 2. TimlgSupervisor (Para Operadores de Rondas)
Herramienta para mantener el flujo del protocolo.
```typescript
import { TimlgSupervisor } from '@timlg/sdk';

const supervisor = new TimlgSupervisor(program);

// Abrir nueva ronda automáticamente
await supervisor.createRoundAuto();

// Finalizar ventana de apuestas
await supervisor.finalizeRound(roundId);

// Liquidar premios
await supervisor.settleRoundTokens(roundId, { timlgMint });
```

### 3. TimlgAdmin (Para Gestión del Protocolo)
Control total del sistema (requiere permisos de administrador).
```typescript
import { TimlgAdmin } from '@timlg/sdk';

const admin = new TimlgAdmin(program);

await admin.setPause(true); // Pausa de emergencia
await admin.addOracle(newPublicKey); // Gestión de oráculos
```

## Consultas Comunes
Todas las herramientas incluyen métodos para leer datos del protocolo:
```typescript
const round = await player.fetchRound(roundId);
const stats = await player.fetchUserStats(userPublicKey);
const config = await player.fetchConfig();
```

## Verificación
El código está diseñado para ser compatible con entornos ESM y NodeNext.
© 2026 TIMLG Protocol.

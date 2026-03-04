<div align="center">
  <img src="https://raw.githubusercontent.com/pi-apps/pi-platform-docs/master/pi-logo.png" alt="Pi Network Logo" width="100"/>
  <h1>🛡️ Pi Trust</h1>
  <p><strong>Decentralized Reputation, Escrow, and Dispute Resolution for the Pi Network Ecosystem</strong></p>
  
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Stellar](https://img.shields.io/badge/Network-Stellar%20Soroban-black)](https://stellar.org/soroban)
  [![Pi SDK](https://img.shields.io/badge/Integration-Pi%20SDK-purple)](https://developers.minepi.com/)
  [![Node.js](https://img.shields.io/badge/Node.js-Backend-green)](https://nodejs.org/)
  [![React](https://img.shields.io/badge/React-Frontend-blue)](https://reactjs.org/)
</div>

---

## 🌌 Vision
The Pi Network boasts tens of millions of engaged Pioneers. However, as the ecosystem transitions to open Mainnet and P2P commerce accelerates, maintaining trust in a decentralized environment becomes the ultimate bottleneck. **Pi Trust** is the orchestration layer that bridges this gap. It acts as the immutable source of truth for reputation, enabling zero-trust environments to flourish through cryptographically secure Social Passports, staked Vouches, and decentralized Sentinel Arbitration.

## 🚨 The Problem
In decentralized P2P marketplaces, bad actors exploit the lack of centralized oversight to perform "ghost trades," scam honest merchants, and artificially inflate their network standing. Traditional reputation systems (like simple star ratings) are easily manipulated and lack financial consequences. 

## 💡 The Solution (What it does & Why it's needed)
**Pi Trust** introduces a Web3-native reputation economy:
1. **The Trust Passport SBT (Soulbound Token):** A non-transferable on-chain identity minted on the Stellar/Soroban network representing a Pioneer's reputation score.
2. **Skin-in-the-Game Vouching:** Pioneers can vouch for each other by *staking* actual Pi. If the vouchee is convicted of malicious behavior, the voucher's stake is slashed. 
3. **Decentralized Escrow & Disputes:** Trades are secured via escrow. In the event of fraud, disputes are mediated by decentralized "Sentinels" (high-reputation arbitrators) who vote on the outcome.

By attaching financial risk to reputation, Pi Trust mathematically incentivizes honest behavior and mathematically penalizes collusion.

## 🏗️ Architecture & How It Works
The architecture utilizes a hybrid model for optimal UX and on-chain security:

- **Frontend (React + Vite):** A mobile-first, highly responsive Web3 UI that communicates natively with the Pi Browser SDK (`window.Pi`). 
- **Backend (Node.js + Express):** A secure intermediary that validates Pi payments, records high-frequency off-chain metadata in PostgreSQL, and signs Soroban smart contract invocations using a secure Admin Keypair.
- **Smart Contracts (Rust / Stellar Soroban):** The immutable ledger deployed on the Stellar Mainnet handling SBT minting, escrow staking, and slash executions.

### User Flow
1. **Authentication:** User authenticates via the Pi SDK.
2. **Passport Minting:** User pays a minting fee in Pi. The backend verifies the transaction and invokes the Soroban `mint` function.
3. **Vouching:** User stakes Pi on a peer. The backend locks the funds in the Soroban `vouchEscrow` contract.
4. **Disputes:** If a trade goes wrong, a user files a claim (paying a small anti-spam fee). Sentinels vote to convict or dismiss, triggering smart-contract level reward distributions and stake slashings.

## 🔐 Credentials & Configuration
To run a local instance or deploy to production, the following environment variables are required (`.env.production`):

```env
# Server
PORT=3001
NODE_ENV=production

# Stellar / Soroban (Mainnet)
STELLAR_NETWORK=mainnet
STELLAR_RPC=https://soroban-mainnet.stellar.org
PIT_ADMIN_SECRET_KEY=S... (Your secure admin seed)
PIT_ADMIN_PUBLIC_KEY=G... (Your secure admin public key)

# Smart Contract Addresses
PIT_CONTRACT_PASSPORT=C...
PIT_CONTRACT_VOUCH=C...
PIT_CONTRACT_DISPUTE=C...

# Database (Supabase / Render / Neon)
DATABASE_URL=postgresql://user:password@host:port/dbname

# Pi Network Developer Config
PI_API_KEY=your_developer_api_key
```
> **Note:** Vercel deployments require domain ownership verification. A `validation-key.txt` file is placed at `frontend/public/validation-key.txt` for the Pi Developer Portal to automatically verify `trustpi.space`.

## 🧪 Testing Coverage & Verification
The codebase has undergone strict validation methodologies to ensure mainnet-readiness:

- **Component Layer Validation:** All frontend React `.tsx` files successfully mapped dynamically to realistic API states, bypassing local developmental bottlenecks.
- **Payment Lifecycle Security:** The `usePiPayment.ts` hook enforces rigorous state transitions (`awaiting_approval` -> `processing` -> `completed`), safely handling Pi SDK transaction cancellations and errors. Dynamic `paymentType` routing prevents endpoint tampering.
- **Database Resilience:** `db/client.ts` enforces `rejectUnauthorized: false` for strict SSL handshakes with remote PostgreSQL instances (Supabase).
- **Smart Contract Bridging:** Verification that Express API endpoints successfully marshall transaction IDs and execute `CONTRACTS.disputeRegistry.file_dispute()`, `CONTRACTS.vouchEscrow.stake()`, and `CONTRACTS.passportSbt.mint()` via the Stellar SDK.

---
*Built with ❤️ for the Pi Network Pioneer Ecosystem.*

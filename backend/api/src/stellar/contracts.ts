/**
 * Stellar/Soroban contract client for PiTrust.
 * Wraps @stellar/stellar-sdk to invoke all 10 deployed contracts.
 * Supports both read-only (simulation) and write (signed tx) calls.
 */

import {
    Networks,
    TransactionBuilder,
    Operation,
    Keypair,
    Address,
    nativeToScVal,
    scValToNative,
    xdr,
    rpc as StellarRpc,
    SorobanDataBuilder,
    BASE_FEE,
} from '@stellar/stellar-sdk';

const NETWORK_PASSPHRASE =
    process.env.STELLAR_NETWORK === 'mainnet'
        ? Networks.PUBLIC
        : Networks.TESTNET;

const RPC_URL = process.env.STELLAR_TESTNET_RPC || 'https://soroban-testnet.stellar.org';

const server = new StellarRpc.Server(RPC_URL, { allowHttp: false });

// ── Contract Addresses (loaded from env after deployment) ────────────────────

export const CONTRACTS = {
    passportSbt: process.env.PIT_PASSPORT_CONTRACT || '',
    vouchEscrow: process.env.PIT_VOUCH_CONTRACT || '',
    disputeRegistry: process.env.PIT_DISPUTE_CONTRACT || '',
    scoreOracle: process.env.PIT_SCORE_CONTRACT || '',
    recoveryEscrow: process.env.PIT_RECOVERY_CONTRACT || '',
    merchantRegistry: process.env.PIT_MERCHANT_CONTRACT || '',
    tradeEscrow: process.env.PIT_TRADE_CONTRACT || '',
    sentinelStaking: process.env.PIT_SENTINEL_CONTRACT || '',
    socialAttestation: process.env.PIT_SOCIAL_CONTRACT || '',
    governanceRegistry: process.env.PIT_GOVERNANCE_CONTRACT || '',
} as const;

// Admin keypair — only used server-side, never exposed to clients
const ADMIN_SECRET = process.env.PIT_ADMIN_SEED || '';
let adminKeypair: Keypair;
try {
    adminKeypair = Keypair.fromSecret(ADMIN_SECRET);
} catch {
    console.warn('⚠️  Admin keypair not configured (ok for read-only mode)');
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ScValArg = xdr.ScVal;

interface ContractCallOptions {
    contractId: string;
    method: string;
    args: ScValArg[];
    signerKeypair?: Keypair;
}

// ── Core invoke helper ────────────────────────────────────────────────────────

export async function simulateContractCall(
    contractId: string,
    method: string,
    args: ScValArg[]
): Promise<unknown> {
    // Use admin account for simulations (no fee needed for reads)
    const sourceAccount = await server.getAccount(adminKeypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: contractId,
                function: method,
                args,
            })
        )
        .setTimeout(30)
        .build();

    const simResult = await server.simulateTransaction(tx);
    if (StellarRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation failed: ${simResult.error}`);
    }

    // Extract return value
    if ('result' in simResult && simResult.result) {
        return scValToNative(simResult.result.retval);
    }
    return null;
}

export async function invokeContract(opts: ContractCallOptions): Promise<string> {
    const signer = opts.signerKeypair ?? adminKeypair;
    const sourceAccount = await server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: opts.contractId,
                function: opts.method,
                args: opts.args,
            })
        )
        .setTimeout(30)
        .build();

    // Simulate first to get footprint + fee estimate
    const simResult = await server.simulateTransaction(tx);
    if (StellarRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Contract simulation error: ${simResult.error}`);
    }

    const preparedTx = StellarRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(signer);

    const response = await server.sendTransaction(preparedTx);
    if (response.status === 'ERROR') {
        throw new Error(`Transaction error: ${JSON.stringify(response)}`);
    }

    // Poll for confirmation
    const hash = response.hash;
    let txResponse = await server.getTransaction(hash);
    while (
        txResponse.status === 'NOT_FOUND'
    ) {
        await new Promise((r) => setTimeout(r, 2000));
        txResponse = await server.getTransaction(hash);
    }

    if (txResponse.status === 'SUCCESS') {
        return hash;
    }
    throw new Error(`Transaction failed: ${txResponse.status}`);
}

// ── Contract-specific helpers ─────────────────────────────────────────────────

/**
 * Read the current score for a wallet from score_oracle contract.
 */
export async function getScore(walletAddress: string): Promise<number> {
    const result = await simulateContractCall(
        CONTRACTS.scoreOracle,
        'get_score',
        [new Address(walletAddress).toScVal()]
    );
    return Number(result ?? 0);
}

/**
 * Write a score update to the score_oracle contract (oracle admin only).
 */
export async function setScore(walletAddress: string, score: number): Promise<string> {
    return invokeContract({
        contractId: CONTRACTS.scoreOracle,
        method: 'set_score',
        args: [
            new Address(walletAddress).toScVal(),
            nativeToScVal(score, { type: 'u32' }),
        ],
    });
}

/**
 * Check if a passport has been minted for a wallet.
 */
export async function isPassportMinted(walletAddress: string): Promise<boolean> {
    const result = await simulateContractCall(
        CONTRACTS.passportSbt,
        'is_minted',
        [new Address(walletAddress).toScVal()]
    );
    return Boolean(result);
}

/**
 * Verify social attestation for a wallet+platform.
 */
export async function verifySocialAttestation(
    walletAddress: string,
    platform: 'Twitter' | 'LinkedIn' | 'GitHub' | 'Telegram'
): Promise<boolean> {
    const platformMap: Record<string, ScValArg> = {
        Twitter: nativeToScVal({ twitter: null }),
        LinkedIn: nativeToScVal({ linked_in: null }),
        GitHub: nativeToScVal({ git_hub: null }),
        Telegram: nativeToScVal({ telegram: null }),
    };
    const result = await simulateContractCall(
        CONTRACTS.socialAttestation,
        'verify_attestation',
        [new Address(walletAddress).toScVal(), platformMap[platform]]
    );
    return Boolean(result);
}

/**
 * Count verified social platforms for a wallet.
 */
export async function countVerifiedPlatforms(walletAddress: string): Promise<number> {
    const result = await simulateContractCall(
        CONTRACTS.socialAttestation,
        'count_verified_platforms',
        [new Address(walletAddress).toScVal()]
    );
    return Number(result ?? 0);
}

export { server, adminKeypair, NETWORK_PASSPHRASE };

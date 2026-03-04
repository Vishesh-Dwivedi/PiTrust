
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

Write-Host "Configuring Stellar CLI for testnet..."
stellar network add testnet --rpc-url https://soroban-testnet.stellar.org --network-passphrase "Test SDF Network ; September 2015" | Out-Null
$env:STELLAR_SECRET_KEY = "SBEXTVPRSBVVBECDMCDHVK5PDIV43W6ZF6CUVUHNPHWORBSJEVPMAEAT"
stellar keys add deployer --secret-key 2>$null | Out-Null

Write-Host "Building Smart Contracts..."
cargo build --target wasm32v1-none --release

$contracts = @(
    "passport_sbt",
    "score_oracle",
    "vouch_escrow",
    "dispute_registry",
    "recovery_escrow",
    "merchant_registry",
    "trade_escrow",
    "sentinel_staking",
    "social_attestation",
    "governance_registry"
)

$envContent = @"
NODE_ENV=testnet
PORT=3001
STELLAR_NETWORK=testnet
STELLAR_TESTNET_RPC=https://soroban-testnet.stellar.org
STELLAR_TESTNET_HORIZON=https://horizon-testnet.stellar.org
PI_API_BASE=https://api.minepi.com
PI_API_KEY=YOUR_PI_API_KEY_HERE
PIT_ADMIN_SEED=SBEXTVPRSBVVBECDMCDHVK5PDIV43W6ZF6CUVUHNPHWORBSJEVPMAEAT
DATABASE_URL=postgresql://pitrust:pitrust_dev@localhost:5432/pitrust_testnet
REDIS_URL=redis://localhost:6379
SCORE_ENGINE_URL=http://localhost:8001
SCORE_ENGINE_SECRET=pitrust-internal-secret
"@

Write-Host "Deploying Contracts to Testnet..."

foreach ($contract in $contracts) {
    Write-Host "Deploying module $contract..."
    $wasmPath = "target/wasm32-unknown-unknown/release/${contract}.wasm"
    
    # Try the alternate path if the first doesn't exist (recent stellar CLI updates use wasm32v1-none)
    if (-Not (Test-Path $wasmPath)) {
        $wasmPath = "target/wasm32v1-none/release/${contract}.wasm"
    }

    $address = stellar contract deploy --wasm $wasmPath --source-account deployer --network testnet
    $address = $address.Trim()
    
    Write-Host "$contract deployed at $address"
    
    $envVarName = "PIT_" + $contract.ToUpper() + "_CONTRACT"
    $envContent += "`n${envVarName}=${address}"
}

Set-Content -Path ".env.testnet" -Value $envContent
Write-Host "Done! .env.testnet generated."

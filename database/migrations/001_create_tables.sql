-- Web3 Analytics Dashboard — Initial Schema
-- Creates core tables for transaction and activity tracking

CREATE TABLE IF NOT EXISTS token_transfers (
    id              SERIAL PRIMARY KEY,
    transaction_hash VARCHAR(66) NOT NULL,
    block_number    BIGINT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    from_address    VARCHAR(42) NOT NULL,
    to_address      VARCHAR(42) NOT NULL,
    value           NUMERIC(78,0) NOT NULL,
    gas_used        BIGINT,
    gas_price       NUMERIC(78,0),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(transaction_hash)
);

CREATE TABLE IF NOT EXISTS user_activities (
    id              SERIAL PRIMARY KEY,
    transaction_hash VARCHAR(66) NOT NULL,
    wallet_address  VARCHAR(42) NOT NULL,
    activity_type   VARCHAR(20) NOT NULL,
    amount          NUMERIC(78,0) NOT NULL,
    block_number    BIGINT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS _meta (
    key   VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_transfers_block ON token_transfers(block_number);
CREATE INDEX IF NOT EXISTS idx_transfers_timestamp ON token_transfers(block_timestamp);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON token_transfers(from_address);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON token_transfers(to_address);
CREATE INDEX IF NOT EXISTS idx_activities_wallet ON user_activities(wallet_address);
CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON user_activities(block_timestamp);
CREATE INDEX IF NOT EXISTS idx_activities_type ON user_activities(activity_type);

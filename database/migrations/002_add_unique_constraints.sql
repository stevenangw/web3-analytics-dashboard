-- Add composite UNIQUE constraint on user_activities
-- Prevents duplicate entries for same transaction+wallet+activity combination
-- Run deduplicate.sql FIRST if upgrading existing database

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_user_activity'
    ) THEN
        ALTER TABLE user_activities
        ADD CONSTRAINT uq_user_activity
        UNIQUE (transaction_hash, wallet_address, activity_type);
    END IF;
END
$$;

-- ============================================================
-- Deduplication Script for user_activities
-- ============================================================
--
-- PURPOSE:
--   Removes duplicate rows from the user_activities table,
--   keeping only the row with the lowest id for each unique
--   combination of (transaction_hash, wallet_address, activity_type).
--
-- WHEN TO RUN:
--   - BEFORE applying migration 002_add_unique_constraints.sql
--     on an existing database that may contain duplicate entries.
--   - Safe to run multiple times (idempotent) — if no duplicates
--     exist, zero rows are deleted.
--
-- HOW IT WORKS:
--   Uses a CTE with ROW_NUMBER() to identify duplicates within
--   each partition. Rows with rn > 1 are duplicates and are deleted.
-- ============================================================

WITH duplicates AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY transaction_hash, wallet_address, activity_type
               ORDER BY id ASC
           ) AS rn
    FROM user_activities
)
DELETE FROM user_activities
WHERE id IN (
    SELECT id FROM duplicates WHERE rn > 1
);

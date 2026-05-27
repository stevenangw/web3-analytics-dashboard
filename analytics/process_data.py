#!/usr/bin/env python3
"""Web3 Analytics Engine — Dynamic 14-Day Rolling Analytics Pipeline

Computes daily statistics, wallet summaries, and RFM segmentation
from PostgreSQL data. All time bounds are dynamically calculated.
Outputs timestamped CSV files to analytics/output/.
"""

import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
import pandas as pd
import psycopg2
from dotenv import load_dotenv

# Load env from project root
load_dotenv(Path(__file__).resolve().parent.parent / '.env')


def get_connection():
    """Create and return a PostgreSQL database connection using env vars."""
    return psycopg2.connect(
        host=os.getenv('DB_HOST', 'localhost'),
        port=os.getenv('DB_PORT', '5432'),
        database=os.getenv('DB_NAME', 'web3analytics'),
        user=os.getenv('DB_USER', 'postgres'),
        password=os.getenv('DB_PASSWORD', 'postgres')
    )


def compute_daily_stats(conn, start_date, end_date):
    """Compute DAU, daily volume, daily gas expenditure scaled down to standard units."""
    # Query token_transfers within the window
    query = """
        SELECT 
            DATE(block_timestamp AT TIME ZONE 'UTC') as tx_date,
            COUNT(*) as tx_count,
            COUNT(DISTINCT from_address) + COUNT(DISTINCT to_address) as unique_wallets_approx,
            COALESCE(SUM(value / 10^18), 0)::numeric as total_volume,
            COALESCE(SUM(CASE WHEN gas_used IS NOT NULL AND gas_price IS NOT NULL 
                         THEN (gas_used * gas_price) / 10^18 ELSE 0 END), 0)::numeric as total_gas_cost
        FROM token_transfers
        WHERE block_timestamp >= %s AND block_timestamp < %s
        GROUP BY DATE(block_timestamp AT TIME ZONE 'UTC')
        ORDER BY tx_date
    """
    df = pd.read_sql_query(query, conn, params=[start_date, end_date])
    return df


def compute_dau(conn, start_date, end_date):
    """Compute true Daily Active Users from user_activities."""
    query = """
        SELECT 
            DATE(block_timestamp AT TIME ZONE 'UTC') as activity_date,
            COUNT(DISTINCT wallet_address) as dau
        FROM user_activities
        WHERE block_timestamp >= %s AND block_timestamp < %s
        GROUP BY DATE(block_timestamp AT TIME ZONE 'UTC')
        ORDER BY activity_date
    """
    df = pd.read_sql_query(query, conn, params=[start_date, end_date])
    return df


def compute_rfm(conn, start_date, end_date, now):
    """Compute RFM (Recency, Frequency, Monetary) segmentation per wallet."""
    query = """
        SELECT 
            wallet_address,
            MAX(block_timestamp) as last_activity,
            COUNT(*) as frequency,
            SUM(amount / 10^18)::numeric as monetary
        FROM user_activities
        WHERE block_timestamp >= %s AND block_timestamp < %s
        GROUP BY wallet_address
    """
    df = pd.read_sql_query(query, conn, params=[start_date, end_date])

    if df.empty:
        print('[WARN] No activity data found for RFM computation.')
        return df

    # Recency: days since last activity
    df['last_activity'] = pd.to_datetime(df['last_activity'], utc=True)
    df['recency_days'] = (now - df['last_activity']).dt.total_seconds() / 86400

    # RFM Scoring (1-5, 5 is best)
    # For recency, lower is better so we invert
    try:
        df['r_score'] = pd.qcut(df['recency_days'], q=5, labels=[5, 4, 3, 2, 1], duplicates='drop').astype(int)
    except ValueError:
        df['r_score'] = 3  # fallback if not enough unique values
    try:
        df['f_score'] = pd.qcut(df['frequency'], q=5, labels=[1, 2, 3, 4, 5], duplicates='drop').astype(int)
    except ValueError:
        df['f_score'] = 3
    try:
        df['monetary'] = pd.to_numeric(df['monetary'], errors='coerce').fillna(0)
        df['m_score'] = pd.qcut(df['monetary'], q=5, labels=[1, 2, 3, 4, 5], duplicates='drop').astype(int)
    except ValueError:
        df['m_score'] = 3

    df['rfm_score'] = df['r_score'] * 100 + df['f_score'] * 10 + df['m_score']

    # Segment labels
    def segment(row):
        if row['r_score'] >= 4 and row['f_score'] >= 4:
            return 'Champion'
        elif row['r_score'] >= 3 and row['f_score'] >= 3:
            return 'Loyal'
        elif row['r_score'] >= 4 and row['f_score'] <= 2:
            return 'New User'
        elif row['r_score'] <= 2 and row['f_score'] >= 3:
            return 'At Risk'
        elif row['r_score'] <= 2 and row['f_score'] <= 2:
            return 'Hibernating'
        else:
            return 'Potential'

    df['segment'] = df.apply(segment, axis=1)
    return df


def compute_wallet_summary(conn, start_date, end_date):
    """Summary stats per wallet."""
    query = """
        SELECT 
            wallet_address,
            activity_type,
            COUNT(*) as count,
            SUM(amount / 10^18)::numeric as total_amount,
            MIN(block_timestamp) as first_seen,
            MAX(block_timestamp) as last_seen
        FROM user_activities
        WHERE block_timestamp >= %s AND block_timestamp < %s
        GROUP BY wallet_address, activity_type
        ORDER BY total_amount DESC
    """
    df = pd.read_sql_query(query, conn, params=[start_date, end_date])
    return df


def main():
    print('=' * 60)
    print('Web3 Analytics Engine — Dynamic 14-Day Rolling Pipeline')
    print('=' * 60)

    # Dynamic time bounds — query DB for highest timestamp to anchor window, fallback to UTC now
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT GREATEST(
                (SELECT MAX(block_timestamp) FROM user_activities),
                (SELECT MAX(block_timestamp) FROM token_transfers)
            )
        """)
        max_time = cursor.fetchone()[0]
        cursor.close()
        conn.close()
        if max_time:
            # Handle tz-aware datetime from pg
            now = max_time
            if now.tzinfo is None:
                now = now.replace(tzinfo=timezone.utc)
        else:
            now = datetime.now(timezone.utc)
    except Exception:
        now = datetime.now(timezone.utc)

    end_date = now
    start_date = now - timedelta(days=14)

    print(f'Analysis window: {start_date.isoformat()} → {end_date.isoformat()}')
    print(f'Generated at: {now.isoformat()}')
    print()

    # Output directory
    output_dir = Path(__file__).resolve().parent / 'output'
    output_dir.mkdir(exist_ok=True)
    timestamp_str = now.strftime('%Y%m%d_%H%M%S')

    try:
        conn = get_connection()
        print('[OK] Connected to PostgreSQL')

        # 1. Daily Stats
        print('\n--- Computing Daily Transaction Stats ---')
        daily_stats = compute_daily_stats(conn, start_date, end_date)
        if not daily_stats.empty:
            fname = output_dir / f'daily_stats_{timestamp_str}.csv'
            daily_stats.to_csv(fname, index=False)
            print(f'  Exported: {fname}')
            print(daily_stats.to_string(index=False))
        else:
            print('  No transfer data found in window.')

        # 2. DAU
        print('\n--- Computing Daily Active Users ---')
        dau = compute_dau(conn, start_date, end_date)
        if not dau.empty:
            # Merge with daily_stats
            if not daily_stats.empty:
                daily_stats = daily_stats.merge(dau, left_on='tx_date', right_on='activity_date', how='outer')
                fname = output_dir / f'daily_stats_{timestamp_str}.csv'
                daily_stats.to_csv(fname, index=False)
                print(f'  Updated: {fname}')
            print(dau.to_string(index=False))
        else:
            print('  No activity data found in window.')

        # 3. RFM Segmentation
        print('\n--- Computing RFM Segmentation ---')
        rfm = compute_rfm(conn, start_date, end_date, now)
        if not rfm.empty:
            fname = output_dir / f'rfm_segments_{timestamp_str}.csv'
            rfm.to_csv(fname, index=False)
            print(f'  Exported: {fname}')
            print(f'  Segments: {rfm["segment"].value_counts().to_dict()}')
        else:
            print('  Not enough data for RFM.')

        # 4. Wallet Summary
        print('\n--- Computing Wallet Summary ---')
        wallet = compute_wallet_summary(conn, start_date, end_date)
        if not wallet.empty:
            fname = output_dir / f'wallet_summary_{timestamp_str}.csv'
            wallet.to_csv(fname, index=False)
            print(f'  Exported: {fname}')
            print(f'  Unique wallets: {wallet["wallet_address"].nunique()}')
        else:
            print('  No wallet data found.')

        conn.close()
        print('\n' + '=' * 60)
        print(f'Pipeline complete. Output directory: {output_dir}')
        print('=' * 60)

    except psycopg2.OperationalError as e:
        print(f'[ERROR] Database connection failed: {e}')
        print('Make sure PostgreSQL is running and .env is configured.')
        sys.exit(1)
    except Exception as e:
        print(f'[ERROR] Pipeline failed: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()

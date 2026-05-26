import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured =
  url && key &&
  !url.includes("your-project-id") &&
  !key.includes("your-anon-key");

export const supabase = isSupabaseConfigured
  ? createClient(url, key)
  : null;

// DB row(snake_case) → app state(camelCase)
export function rowToStock(row) {
  return {
    id: row.id,
    name: row.name,
    ticker: row.ticker,
    market: row.market,
    quantity: row.quantity,
    avgPrice: row.avg_price,
    currentPrice: row.current_price,
  };
}

// app state → DB insert/update payload
export function stockToRow(s) {
  return {
    name: s.name,
    ticker: s.ticker,
    market: s.market,
    quantity: s.quantity,
    avg_price: s.avgPrice,
    current_price: s.currentPrice,
  };
}

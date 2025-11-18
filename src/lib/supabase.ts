import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.BUN_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.BUN_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase environment variables. Please set BUN_PUBLIC_SUPABASE_URL and BUN_PUBLIC_SUPABASE_ANON_KEY"
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);


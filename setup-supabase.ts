#!/usr/bin/env bun

/**
 * This script helps set up Supabase tables for the WebRTC screen share app.
 * 
 * Since Supabase doesn't allow creating tables via the REST API with anon key,
 * this script will:
 * 1. Verify your Supabase connection
 * 2. Display the SQL schema you need to run
 * 3. Optionally open the Supabase SQL editor for you
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.BUN_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.BUN_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ Missing Supabase environment variables!");
  console.error("Please set BUN_PUBLIC_SUPABASE_URL and BUN_PUBLIC_SUPABASE_ANON_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function checkTables() {
  console.log("🔍 Checking if tables exist...\n");

  // Try to query the offers table
  const { data: offersData, error: offersError } = await supabase
    .from("offers")
    .select("id")
    .limit(1);

  const { data: answersData, error: answersError } = await supabase
    .from("answers")
    .select("id")
    .limit(1);

  if (offersError && offersError.code === "PGRST116") {
    console.log("❌ 'offers' table does not exist");
  } else if (offersError) {
    console.log(`⚠️  Error checking 'offers' table: ${offersError.message}`);
  } else {
    console.log("✅ 'offers' table exists");
  }

  if (answersError && answersError.code === "PGRST116") {
    console.log("❌ 'answers' table does not exist");
  } else if (answersError) {
    console.log(`⚠️  Error checking 'answers' table: ${answersError.message}`);
  } else {
    console.log("✅ 'answers' table exists");
  }

  return !offersError && !answersError;
}

async function main() {
  console.log("🚀 Supabase Setup Helper\n");
  console.log(`📍 Supabase URL: ${supabaseUrl}\n`);

  const tablesExist = await checkTables();

  if (tablesExist) {
    console.log("\n✅ All tables exist! You're good to go!");
    return;
  }

  console.log("\n📋 To create the tables, run this SQL in your Supabase SQL Editor:\n");
  console.log("─".repeat(60));
  
  const fs = await import("fs");
  const sql = fs.readFileSync("./supabase-schema.sql", "utf-8");
  console.log(sql);
  
  console.log("─".repeat(60));
  console.log("\n📝 Steps:");
  console.log("1. Go to your Supabase dashboard: https://supabase.com/dashboard");
  console.log("2. Select your project");
  console.log("3. Go to SQL Editor");
  console.log("4. Paste the SQL above and click 'Run'");
  console.log("\n🔗 Or open directly:");
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  if (projectRef) {
    console.log(`   https://supabase.com/dashboard/project/${projectRef}/sql`);
  }
  console.log("\n✨ After running the SQL, restart your dev server and try again!");
}

main().catch(console.error);


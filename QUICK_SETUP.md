# Quick Setup Guide

## Create Supabase Tables

Since Supabase requires authentication to execute SQL, please follow these steps:

### Option 1: Via Supabase Dashboard (Recommended)

1. **Open SQL Editor:**
   - Go to: https://supabase.com/dashboard/project/psbmuerdpmkajkkldqtz/sql
   - Or navigate: Dashboard → Your Project → SQL Editor

2. **Copy and paste this SQL:**

```sql
-- Create offers table
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  offer JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'denied', 'completed'))
);

-- Create answers table
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  answer JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE answers ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read offers (for presenter to see incoming offers)
CREATE POLICY "Anyone can read offers" ON offers
  FOR SELECT USING (true);

-- Allow anyone to insert offers (for casters to create offers)
CREATE POLICY "Anyone can insert offers" ON offers
  FOR INSERT WITH CHECK (true);

-- Allow anyone to update offers (for presenter to accept/deny)
CREATE POLICY "Anyone can update offers" ON offers
  FOR UPDATE USING (true);

-- Allow anyone to read answers (for casters to receive answers)
CREATE POLICY "Anyone can read answers" ON answers
  FOR SELECT USING (true);

-- Allow anyone to insert answers (for presenter to send answers)
CREATE POLICY "Anyone can insert answers" ON answers
  FOR INSERT WITH CHECK (true);

-- Create index on offer_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_answers_offer_id ON answers(offer_id);

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
```

3. **Click "Run"** to execute the SQL

4. **Verify setup:**
   ```bash
   bun setup-supabase.ts
   ```

### Option 2: Via Supabase CLI (if installed)

```bash
supabase db push
# Or if you have migrations set up:
supabase migration new create_webrtc_tables
# Then copy the SQL into the migration file and run:
supabase db reset
```

## After Setup

Once tables are created, restart your dev server:

```bash
bun run dev
```

Then test the app:
1. Open http://localhost:3000 in one tab (Caster)
2. Open http://localhost:3000 in another tab (Presenter)
3. Click "Start Screen Share" in the Caster tab (it will use a dummy stream)
4. Accept the offer in the Presenter tab
5. Watch the WebRTC connection establish!


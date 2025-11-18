CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create offers table
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  offer JSONB NOT NULL,
  caster_name TEXT,
  room_code TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'denied', 'completed'))
);

-- Create answers table
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
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


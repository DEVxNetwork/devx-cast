# WebRTC Screen Share with Supabase

A WebRTC-based screen sharing application that uses Supabase for signaling between casters and presenters.

## Prerequisites

- [Bun](https://bun.sh) installed on your system

## Setup

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Set up Supabase:**
   - Create a new Supabase project at https://supabase.com
   - Get your project URL and anon key from the project settings

3. **Configure environment variables:**
   Create a `.env.local` file (or `.env`) in the root directory:
   ```
   BUN_PUBLIC_SUPABASE_URL=your_supabase_project_url
   BUN_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```
   
   Bun automatically loads `.env.local` / `.env` and exposes variables prefixed with `BUN_PUBLIC_*` to the client. `.env.local` is typically gitignored, which makes it a safe place for local credentials.

4. **Set up database tables:**
   - Run `bun setup-supabase.ts` — the helper script checks tables and prints the SQL you need
   - Copy the SQL (also found in `supabase-schema.sql`) into the Supabase SQL editor and click **Run**
   - The script will verify your connection and guide you through the setup

5. **Run the development server:**
   ```bash
   bun run dev
   ```

6. **Open the app:**
   The server will display the URL when it starts (typically `http://localhost:3000`). Open that URL in your browser.

## How it works

### Caster console
- Capture a real screen share or fall back to a dummy video stream for testing
- Publish a Supabase offer with metadata (name + room code)
- Share a one-click invite link (`?role=presenter&room=XXXXXX`)
- Auto-subscribes to answers via Supabase Realtime and finalizes the WebRTC connection when the presenter accepts

### Presenter console
- Live feed of pending offers, filterable by room code
- Accept/deny buttons write directly to Supabase and create the WebRTC answer
- Active feeds render inline players with fullscreen controls
- Connection health tracked via RTCPeerConnection state

## Database Schema

The application uses two tables:
- `offers`: WebRTC offer SDP + metadata (`caster_name`, `room_code`, `status`)
- `answers`: WebRTC answer SDP linked to an offer

See `supabase-schema.sql` for the complete schema definition.

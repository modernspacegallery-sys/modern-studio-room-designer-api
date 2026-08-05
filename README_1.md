# Môdern Studio — Room Designer API

A single Vercel serverless function that takes a room photo + a style, asks
OpenAI to redesign it (while preserving the room's architecture), and
returns the result. This keeps your OpenAI API key off the storefront —
the theme will call this endpoint instead of calling OpenAI directly.

## Deploy (about 5 minutes)

1. **Get this code into a GitHub repo.**
   Easiest path: create a new empty repo on GitHub (e.g.
   `modern-studio-room-designer-api`), then upload these three files to it
   (`api/redesign.js`, `package.json`, `README.md`) using GitHub's
   "Add file → Upload files" button in the browser — no git command line
   needed.

2. **Create a Vercel account** (free) at vercel.com if you don't have one,
   using "Continue with GitHub" so it can see your repos.

3. **Import the project.**
   In the Vercel dashboard: "Add New" → "Project" → select the GitHub repo
   you just created → click "Deploy". Vercel auto-detects this as a Node
   serverless function project; you don't need to change any build settings.

4. **Add your environment variables.**
   In the Vercel project → Settings → Environment Variables, add:
   - `OPENAI_API_KEY` — your OpenAI API key (from platform.openai.com)
   - `ALLOWED_ORIGIN` — `https://modernspacegallery.com` (locks down which
     site can call this function; prevents other sites from using your key)

   After adding these, go to the "Deployments" tab and re-deploy (or push
   any small change) so the new env vars take effect.

5. **Copy your live URL.**
   Vercel will give you a URL like `https://modern-studio-room-designer-api.vercel.app`.
   Your endpoint is `https://your-project.vercel.app/api/redesign`.

6. **Send that URL back** and the AI Room Designer tool in the theme can be
   wired up to call it.

## What this does NOT include yet

- Rate limiting (right now, anyone with the endpoint URL could call it
  repeatedly — low risk since `ALLOWED_ORIGIN` blocks browser calls from
  other sites, but a determined person could still hit it directly). Worth
  adding IP-based rate limiting via Vercel's Edge Config or a simple KV
  store once this is live and being used.
- Image storage — results are returned directly to the browser and not
  saved anywhere. If you want a "my saved designs" feature later, that
  needs a database, which is a bigger addition.

## Cost

OpenAI's `gpt-image-1` image edits are priced per image (check
platform.openai.com/pricing for current rates — this changes periodically).
There's no cost until someone actually uses the tool; Vercel's free tier
covers this function's traffic comfortably at low-to-moderate volume.

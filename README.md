# ⚡ Ad Factory

A static ad generator that takes Claude-generated ad concepts and batch-renders them using Google's Gemini image generation API (Nano Banana).

## How It Works

1. **Set up a brand** — name, colors, logo, disclaimer text, reference images
2. **Paste Claude concepts** — the parser extracts concept names, headlines, and visual prompts
3. **Batch generate** — select concepts, hit generate, and watch them render in real-time via SSE
4. **Manage results** — star winners, download, delete, filter

## Setup on Replit

1. Import this project into Replit
2. Add your `GEMINI_API_KEY` in Replit Secrets (get one at https://aistudio.google.com/apikey)
3. Click Run — the app starts on port 5000

## Concept Paste Format

Paste concepts from Claude in this format:

```
CONCEPT 1 — "Double The Peptides, Zero Extra Spend"

Visual World: Molecular structure / DNA helix environment

VISUAL PROMPT FOR NANO BANANA:

"Create a 1:1 ratio static ad. Background: Deep blue (#1E3A8A) gradient with large semi-transparent 3D molecular structures..."

---

CONCEPT 2 — "Lab-Verified Purity"

VISUAL PROMPT FOR NANO BANANA:

"Create a 1:1 ratio static ad..."
```

The parser handles:
- `CONCEPT N — "Name"` headers
- `VISUAL PROMPT FOR NANO BANANA:` sections
- `---` separators between concepts
- Headline extraction from within prompts

## Brand Assets

Upload reference images that get sent alongside every prompt:
- **Logo** — your brand logo
- **Example Ads** — winning ads for style reference
- **Badges** — "BOGO", "Limited Time", etc.
- **Product Shots** — product images

Toggle "Include" on each asset to control which ones are attached to generation calls.

## Tech Stack

- Node.js + Express
- SQLite (better-sqlite3)
- Gemini 2.5 Flash Image API
- Vanilla JS frontend with Tailwind-inspired custom CSS
- SSE for real-time batch progress

## API Endpoints

- `GET/POST /api/brands` — brand CRUD
- `POST /api/brands/:id/logo` — logo upload
- `GET/POST /api/brands/:id/assets` — asset management
- `POST /api/concepts/batch` — import parsed concepts
- `POST /api/generate` — single generation
- `POST /api/generate/batch` — batch generation (SSE stream)
- `GET /api/generations` — list generated ads

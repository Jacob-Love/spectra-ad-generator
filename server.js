require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { initDb } = require('./database/init');

const app = express();
const PORT = process.env.PORT || 5000;
let db = null;

// --- Directories ---
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const BRAND_DIR = path.join(UPLOADS_DIR, 'brand');
const ASSET_DIR = path.join(UPLOADS_DIR, 'assets');
const GENERATED_DIR = path.join(UPLOADS_DIR, 'generated');

[PUBLIC_DIR, BRAND_DIR, ASSET_DIR, GENERATED_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// --- Middleware ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// --- Multer ---
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml']);

function makeStorage(dir) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
  });
}

const brandUpload = multer({ storage: makeStorage(BRAND_DIR), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (_r, f, cb) => cb(null, MIME_TYPES.has(f.mimetype)) });
const assetUpload = multer({ storage: makeStorage(ASSET_DIR), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (_r, f, cb) => cb(null, MIME_TYPES.has(f.mimetype)) });

// --- Helpers ---
function slugify(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  return map[ext] || 'application/octet-stream';
}

function toPublicPath(absPath) {
  return '/' + path.relative(PUBLIC_DIR, absPath).replace(/\\/g, '/');
}

function resolveUploadPath(publicPath) {
  const cleaned = String(publicPath || '').replace(/^\/+/, '');
  return path.join(PUBLIC_DIR, cleaned);
}

function getGeminiKey() {
  return process.env.GEMINI_API_KEY || '';
}

// --- Gemini Image Generation ---
async function generateImageWithGemini({ prompt, referenceImages = [], aspectRatio = '1:1' }) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY not set.');

  // Build multimodal content parts
  const parts = [];

  // Add reference images first (logo, example ads, badges, etc.)
  for (const imgPath of referenceImages) {
    const absPath = imgPath.startsWith('/') && !imgPath.startsWith(PUBLIC_DIR) ? resolveUploadPath(imgPath) : imgPath;
    const realPath = fs.existsSync(absPath) ? absPath : resolveUploadPath(imgPath);
    if (fs.existsSync(realPath)) {
      const bytes = fs.readFileSync(realPath);
      parts.push({
        inline_data: {
          mime_type: getMimeType(realPath),
          data: bytes.toString('base64')
        }
      });
    }
  }

  // Add the text prompt
  parts.push({ text: prompt });

  const model = 'gemini-3-pro-image-preview';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio }
    }
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Invalid Gemini response: ${raw.slice(0, 300)}`); }

  if (!response.ok) {
    const msg = parsed?.error?.message || raw.slice(0, 300);
    throw new Error(`Gemini API error (${response.status}): ${msg}`);
  }

  // Extract generated image from response
  const candidate = parsed?.candidates?.[0];
  const candidateParts = candidate?.content?.parts || [];

  let imageData = null;
  let textResponse = '';
  for (const part of candidateParts) {
    if (part.inlineData || part.inline_data) {
      imageData = part.inlineData || part.inline_data;
    }
    if (part.text) {
      textResponse += part.text;
    }
  }

  if (!imageData) {
    throw new Error(`Gemini did not return an image. Text response: ${textResponse.slice(0, 500)}`);
  }

  // Save to disk
  const mimeType = imageData.mimeType || imageData.mime_type || '';
  const ext = mimeType.includes('png') ? '.png' : '.jpg';
  const filename = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const absOutputPath = path.join(GENERATED_DIR, filename);
  fs.writeFileSync(absOutputPath, Buffer.from(imageData.data, 'base64'));

  return { imagePath: toPublicPath(absOutputPath), textResponse };
}

// --- Async wrapper ---
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ===================== API ROUTES =====================

// --- Health ---
app.get('/api/health', (_req, res) => res.json({ ok: true, gemini: !!getGeminiKey() }));

// --- Brands CRUD ---
app.get('/api/brands', asyncHandler(async (_req, res) => {
  const brands = db.prepare('SELECT * FROM brands ORDER BY created_at DESC').all();
  res.json(brands);
}));

app.post('/api/brands', asyncHandler(async (req, res) => {
  const { name, description, disclaimer_text, color_primary, color_secondary, color_accent, typography, extra_notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Brand name is required.' });
  const slug = slugify(name);
  const result = db.prepare(`INSERT INTO brands (name, slug, description, disclaimer_text, color_primary, color_secondary, color_accent, typography, extra_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    name, slug, description || '', disclaimer_text || '', color_primary || '#000000', color_secondary || '#333333', color_accent || '#10B981', typography || '', extra_notes || ''
  );
  res.json(db.prepare('SELECT * FROM brands WHERE id = ?').get(result.lastInsertRowid));
}));

app.patch('/api/brands/:id', asyncHandler(async (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found.' });
  const fields = ['name', 'description', 'disclaimer_text', 'color_primary', 'color_secondary', 'color_accent', 'typography', 'extra_notes'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  if (updates.name) updates.slug = slugify(updates.name);
  updates.updated_at = new Date().toISOString();
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE brands SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id));
}));

app.delete('/api/brands/:id', asyncHandler(async (req, res) => {
  db.prepare('DELETE FROM brands WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
}));

// --- Brand logo upload ---
app.post('/api/brands/:id/logo', brandUpload.single('logo'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const logoPath = toPublicPath(req.file.path);
  db.prepare('UPDATE brands SET logo_path = ?, updated_at = ? WHERE id = ?').run(logoPath, new Date().toISOString(), req.params.id);
  res.json({ logo_path: logoPath });
}));

// --- Brand Assets ---
app.get('/api/brands/:id/assets', asyncHandler(async (req, res) => {
  const assets = db.prepare('SELECT * FROM brand_assets WHERE brand_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(assets);
}));

app.post('/api/brands/:id/assets', assetUpload.array('assets', 20), asyncHandler(async (req, res) => {
  const brandId = req.params.id;
  const categories = req.body.categories ? JSON.parse(req.body.categories) : [];
  const includeFlags = req.body.include_in_generation ? JSON.parse(req.body.include_in_generation) : [];
  const results = [];

  for (let i = 0; i < req.files.length; i++) {
    const f = req.files[i];
    const filePath = toPublicPath(f.path);
    const category = categories[i] || 'Other';
    const includeInGen = includeFlags[i] ? 1 : 0;
    const result = db.prepare(`INSERT INTO brand_assets (brand_id, filename, original_name, file_path, category, include_in_generation, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      brandId, f.filename, f.originalname, filePath, category, includeInGen, f.size
    );
    results.push(db.prepare('SELECT * FROM brand_assets WHERE id = ?').get(result.lastInsertRowid));
  }
  res.json(results);
}));

app.patch('/api/brand-assets/:id', asyncHandler(async (req, res) => {
  const { category, label, include_in_generation } = req.body;
  const updates = [];
  const vals = [];
  if (category !== undefined) { updates.push('category = ?'); vals.push(category); }
  if (label !== undefined) { updates.push('label = ?'); vals.push(label); }
  if (include_in_generation !== undefined) { updates.push('include_in_generation = ?'); vals.push(include_in_generation ? 1 : 0); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.params.id);
  db.prepare(`UPDATE brand_assets SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.json(db.prepare('SELECT * FROM brand_assets WHERE id = ?').get(req.params.id));
}));

app.delete('/api/brand-assets/:id', asyncHandler(async (req, res) => {
  const asset = db.prepare('SELECT * FROM brand_assets WHERE id = ?').get(req.params.id);
  if (asset) {
    const absPath = resolveUploadPath(asset.file_path);
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  }
  db.prepare('DELETE FROM brand_assets WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
}));

// --- Concepts ---
app.get('/api/concepts', asyncHandler(async (req, res) => {
  const brandId = req.query.brand_id;
  if (!brandId) return res.status(400).json({ error: 'brand_id required.' });
  const concepts = db.prepare('SELECT * FROM concepts WHERE brand_id = ? ORDER BY created_at DESC').all(brandId);
  res.json(concepts);
}));

app.post('/api/concepts/batch', asyncHandler(async (req, res) => {
  const { brand_id, batch_name, concepts } = req.body;
  if (!brand_id || !concepts || !Array.isArray(concepts) || concepts.length === 0) {
    return res.status(400).json({ error: 'brand_id and concepts array required.' });
  }
  const insert = db.prepare(`INSERT INTO concepts (brand_id, batch_name, concept_name, headline, body_copy, visual_prompt, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const results = [];
  const tx = db.transaction((items) => {
    for (const c of items) {
      const result = insert.run(
        brand_id,
        batch_name || '',
        c.concept_name || 'Untitled',
        c.headline || '',
        c.body_copy || '',
        c.visual_prompt || '',
        JSON.stringify(c.tags || [])
      );
      results.push(result.lastInsertRowid);
    }
  });
  tx(concepts);
  const saved = db.prepare(`SELECT * FROM concepts WHERE id IN (${results.map(() => '?').join(',')})`).all(...results);
  res.json(saved);
}));

app.patch('/api/concepts/:id', asyncHandler(async (req, res) => {
  const fields = ['concept_name', 'headline', 'body_copy', 'visual_prompt', 'tags', 'status'];
  const updates = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      vals.push(f === 'tags' ? JSON.stringify(req.body[f]) : req.body[f]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.params.id);
  db.prepare(`UPDATE concepts SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.json(db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id));
}));

app.delete('/api/concepts/:id', asyncHandler(async (req, res) => {
  db.prepare('DELETE FROM concepts WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
}));

// --- Generation ---
app.post('/api/generate', asyncHandler(async (req, res) => {
  const { brand_id, concept_id, prompt, aspect_ratio, include_brand_assets } = req.body;
  if (!brand_id || !prompt) return res.status(400).json({ error: 'brand_id and prompt required.' });

  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id);
  if (!brand) return res.status(404).json({ error: 'Brand not found.' });

  // Gather reference images
  const referenceImages = [];

  // Add logo if it exists
  if (brand.logo_path) referenceImages.push(brand.logo_path);

  // Add brand assets marked for generation
  if (include_brand_assets !== false) {
    const assets = db.prepare('SELECT * FROM brand_assets WHERE brand_id = ? AND include_in_generation = 1 ORDER BY category, created_at').all(brand_id);
    for (const a of assets) referenceImages.push(a.file_path);
  }

  // Build the full prompt with brand context
  let fullPrompt = prompt;
  if (brand.disclaimer_text) {
    fullPrompt += `\n\nIMPORTANT: Include this disclaimer text on the ad: "${brand.disclaimer_text}"`;
  }

  const result = await generateImageWithGemini({
    prompt: fullPrompt,
    referenceImages,
    aspectRatio: aspect_ratio || '1:1'
  });

  // Save generation record
  const gen = db.prepare(`INSERT INTO generations (brand_id, concept_id, prompt_used, aspect_ratio, image_path, status) VALUES (?, ?, ?, ?, ?, 'completed')`).run(
    brand_id, concept_id || null, fullPrompt, aspect_ratio || '1:1', result.imagePath
  );

  // Update concept status if linked
  if (concept_id) {
    db.prepare("UPDATE concepts SET status = 'generated' WHERE id = ?").run(concept_id);
  }

  res.json({
    id: gen.lastInsertRowid,
    image_path: result.imagePath,
    text_response: result.textResponse,
    concept_id
  });
}));

// --- Batch Generation ---
app.post('/api/generate/batch', asyncHandler(async (req, res) => {
  const { brand_id, concept_ids, aspect_ratio } = req.body;
  if (!brand_id || !concept_ids || !Array.isArray(concept_ids)) {
    return res.status(400).json({ error: 'brand_id and concept_ids array required.' });
  }

  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id);
  if (!brand) return res.status(404).json({ error: 'Brand not found.' });

  // Get reference images
  const referenceImages = [];
  if (brand.logo_path) referenceImages.push(brand.logo_path);
  const assets = db.prepare('SELECT * FROM brand_assets WHERE brand_id = ? AND include_in_generation = 1 ORDER BY category, created_at').all(brand_id);
  for (const a of assets) referenceImages.push(a.file_path);

  // Start SSE stream for progress
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const concepts = db.prepare(`SELECT * FROM concepts WHERE id IN (${concept_ids.map(() => '?').join(',')}) AND brand_id = ?`).all(...concept_ids, brand_id);

  const total = concepts.length;
  let completed = 0;
  let failed = 0;

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ type: 'start', total, message: `Starting batch generation of ${total} ads...` });

  for (const concept of concepts) {
    try {
      let fullPrompt = concept.visual_prompt;
      if (brand.disclaimer_text) {
        fullPrompt += `\n\nIMPORTANT: Include this disclaimer text on the ad: "${brand.disclaimer_text}"`;
      }

      sendEvent({ type: 'progress', concept_id: concept.id, concept_name: concept.concept_name, status: 'generating', completed, failed, total });

      const result = await generateImageWithGemini({
        prompt: fullPrompt,
        referenceImages,
        aspectRatio: aspect_ratio || '1:1'
      });

      const gen = db.prepare(`INSERT INTO generations (brand_id, concept_id, prompt_used, aspect_ratio, image_path, status) VALUES (?, ?, ?, ?, ?, 'completed')`).run(
        brand_id, concept.id, fullPrompt, aspect_ratio || '1:1', result.imagePath
      );

      db.prepare("UPDATE concepts SET status = 'generated' WHERE id = ?").run(concept.id);

      completed++;
      sendEvent({
        type: 'completed',
        concept_id: concept.id,
        concept_name: concept.concept_name,
        generation_id: gen.lastInsertRowid,
        image_path: result.imagePath,
        completed,
        failed,
        total
      });
    } catch (err) {
      failed++;
      db.prepare(`INSERT INTO generations (brand_id, concept_id, prompt_used, aspect_ratio, image_path, status, error_message) VALUES (?, ?, ?, ?, '', 'failed', ?)`).run(
        brand_id, concept.id, concept.visual_prompt, aspect_ratio || '1:1', err.message || 'Unknown error'
      );
      db.prepare("UPDATE concepts SET status = 'failed' WHERE id = ?").run(concept.id);

      sendEvent({
        type: 'error',
        concept_id: concept.id,
        concept_name: concept.concept_name,
        error: err.message,
        completed,
        failed,
        total
      });
    }
  }

  sendEvent({ type: 'done', completed, failed, total, message: `Batch complete: ${completed} succeeded, ${failed} failed.` });
  res.write('data: [DONE]\n\n');
  res.end();
}));

// --- Generations ---
app.get('/api/generations', asyncHandler(async (req, res) => {
  const brandId = req.query.brand_id;
  if (!brandId) return res.status(400).json({ error: 'brand_id required.' });
  const gens = db.prepare(`
    SELECT g.*, c.concept_name, c.headline, c.tags as concept_tags
    FROM generations g
    LEFT JOIN concepts c ON g.concept_id = c.id
    WHERE g.brand_id = ? AND g.status = 'completed'
    ORDER BY g.created_at DESC
  `).all(brandId);
  res.json(gens);
}));

app.patch('/api/generations/:id', asyncHandler(async (req, res) => {
  const { is_winner, tags } = req.body;
  const updates = [];
  const vals = [];
  if (is_winner !== undefined) { updates.push('is_winner = ?'); vals.push(is_winner ? 1 : 0); }
  if (tags !== undefined) { updates.push('tags = ?'); vals.push(JSON.stringify(tags)); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.params.id);
  db.prepare(`UPDATE generations SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.json(db.prepare('SELECT * FROM generations WHERE id = ?').get(req.params.id));
}));

app.delete('/api/generations/:id', asyncHandler(async (req, res) => {
  const gen = db.prepare('SELECT * FROM generations WHERE id = ?').get(req.params.id);
  if (gen && gen.image_path) {
    const absPath = resolveUploadPath(gen.image_path);
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  }
  db.prepare('DELETE FROM generations WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
}));

// --- Serve frontend ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// --- Error handler ---
app.use((err, _req, res, _next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: err.message || 'Internal server error.' });
});

// --- Start ---
(async () => {
  db = await initDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ad Factory running on port ${PORT}`);
    console.log(`Gemini API: ${getGeminiKey() ? 'Configured' : 'NOT SET — add GEMINI_API_KEY to .env'}`);
  });
})();

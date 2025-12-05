# Nexus Web Dashboard - Quick Start Guide

## Installation

```bash
cd /home/chris/nexus/web
npm install
```

## Development

```bash
# Start dev server
npm run dev

# Open http://localhost:5173
```

## Build & Deploy

```bash
# Build for Cloudflare Pages
npm run build.server

# Deploy to Cloudflare
npm run deploy

# Or deploy via Git (recommended)
# 1. Push to GitHub
# 2. Connect repo in Cloudflare Dashboard
# 3. Build command: npm run build.server
# 4. Output dir: .cloudflare/public
```

## Project Structure

- `src/routes/` - Pages (file-based routing)
- `src/components/ui/` - Reusable components
- `src/lib/` - API client, types, auth
- `public/` - Static files, redirects, headers

## Key Files

- **API Client**: `src/lib/api-client.ts`
- **Types**: `src/lib/types.ts`
- **Auth**: `src/lib/auth-context.tsx`
- **Home**: `src/routes/index.tsx`
- **Capture**: `src/routes/capture/index.tsx`
- **Inbox**: `src/routes/inbox/index.tsx`
- **Tasks**: `src/routes/tasks/index.tsx`

## API Configuration

Update backend URL in `public/_redirects`:

```
# Local development
/api/*  http://localhost:8787/api/:splat  200

# Production
/api/*  https://your-api.workers.dev/api/:splat  200
```

## Common Commands

```bash
npm run dev              # Dev server
npm run build.server     # Build for production
npm run deploy           # Deploy to Cloudflare
npm run lint             # Lint code
npm run fmt              # Format code
npm run build.types      # Type check
```

## Tech Stack

- **Framework**: Qwik 1.17.2
- **Language**: TypeScript
- **Styling**: Tailwind CSS (inline classes)
- **Deployment**: Cloudflare Pages
- **API**: REST + WebSocket

## Features

✅ Voice & text capture
✅ Inbox processing
✅ Kanban task board
✅ Type-safe API client
✅ Auth context (dev mode)
✅ Responsive design

🚧 Projects, Ideas, People, Commitments (placeholders)
🚧 Real-time WebSocket updates
🚧 Speech-to-text integration

## Troubleshooting

**Port already in use**:
```bash
# Kill process on port 5173
lsof -ti:5173 | xargs kill -9
```

**API not connecting**:
- Check `public/_redirects` points to correct backend
- Ensure backend is running on port 8787

**Build fails**:
```bash
rm -rf node_modules package-lock.json
npm install
```

## Documentation

- Full docs: `README.md`
- Implementation summary: `/home/chris/nexus/WEB_DASHBOARD_SUMMARY.md`
- Qwik docs: https://qwik.dev

---

**Ready to build!** 🚀

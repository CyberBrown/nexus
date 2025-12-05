# Nexus Web Dashboard

Voice-first AI-powered productivity dashboard built with Qwik and Cloudflare Pages.

## Tech Stack

- **Framework**: [Qwik](https://qwik.dev/) - Resumable, instant-loading web apps
- **Deployment**: Cloudflare Pages
- **Language**: TypeScript
- **Styling**: Tailwind CSS (utility classes)
- **API**: RESTful API with WebSocket support
- **State**: Qwik Signals and Context API

## Features

- ✅ Voice and text capture interface
- ✅ Inbox processing with AI classification
- ✅ Kanban-style task board
- ✅ Type-safe API client with error handling
- ✅ Authentication context (dev JWT)
- ✅ Responsive design for mobile and desktop
- 🚧 Projects, ideas, people, and commitments management (placeholders)
- 🚧 Real-time WebSocket updates
- 🚧 Speech-to-text integration

## Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build.server

# Deploy to Cloudflare Pages
npm run deploy
```

## Project Structure

See full documentation in comments within files. Key directories:
- `src/components/ui/` - Reusable UI components
- `src/lib/` - API client, types, auth context
- `src/routes/` - Page routes (file-based routing)

## Deployment

Built for Cloudflare Pages with zero-config deployment. See package.json scripts.

## License

See main project license.

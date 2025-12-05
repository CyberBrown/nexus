# CaptureBuffer Durable Object

## Overview

The CaptureBuffer is a Durable Object that buffers rapid voice/text captures before batching them to the InboxManager. It helps reduce API calls, merge related captures, and handle offline scenarios.

## Key Features

1. **Chunk Accumulation**: Buffers multiple capture chunks (e.g., streaming voice transcription)
2. **Intelligent Merging**: Merges related captures within a configurable time window
3. **Auto-Flush**: Automatically flushes based on buffer size, age, or final chunk marker
4. **Offline Support**: Queues captures for later delivery
5. **Per-User Isolation**: Each user has their own buffer instance

## Architecture

```
Mobile App → /api/buffer/append → CaptureBuffer DO → (batch) → InboxManager DO → D1
```

## Configuration

Default settings:
- `maxChunks`: 50 chunks before auto-flush
- `maxAgeMs`: 5000ms (5 seconds) max age before auto-flush
- `mergeWindowMs`: 2000ms (2 seconds) to merge related captures

## API Endpoints

### POST /api/buffer/append

Append a chunk to the buffer. Chunks within the merge window are automatically combined.

**Request:**
```json
{
  "content": "This is a voice transcription chunk",
  "source_type": "voice",
  "source_platform": "android",
  "is_final": false,
  "metadata": {
    "confidence": 0.95
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "chunk_id": "uuid",
    "buffer_length": 3,
    "total_chunks": 12
  }
}
```

### POST /api/buffer/flush

Force flush the buffer immediately (useful for "Send" button).

**Request:**
```json
{
  "capture_id": "optional-specific-capture-to-flush"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "flushed_count": 3,
    "remaining": 0
  }
}
```

### GET /api/buffer/status

Get current buffer status.

**Response:**
```json
{
  "success": true,
  "data": {
    "tenantId": "uuid",
    "buffer_length": 3,
    "total_chunks": 12,
    "oldest_capture_age_ms": 2345,
    "flush_in_progress": false,
    "next_alarm": 1638360000000,
    "config": {
      "maxChunks": 50,
      "maxAgeMs": 5000,
      "mergeWindowMs": 2000
    }
  }
}
```

### GET /api/buffer

Get current buffer contents (for debugging).

**Response:**
```json
{
  "success": true,
  "data": {
    "buffer": [
      {
        "id": "uuid",
        "user_id": "uuid",
        "source_type": "voice",
        "chunk_count": 5,
        "first_chunk_at": "2024-01-01T12:00:00Z",
        "last_chunk_at": "2024-01-01T12:00:03Z",
        "status": "accumulating",
        "age_ms": 3245
      }
    ]
  }
}
```

### POST /api/buffer/configure

Configure buffer settings (per-user).

**Request:**
```json
{
  "maxChunks": 100,
  "maxAgeMs": 10000,
  "mergeWindowMs": 3000
}
```

## Usage Patterns

### Continuous Voice Capture

```typescript
// Mobile app streams voice transcription chunks
async function onTranscriptionChunk(chunk: string, isFinal: boolean) {
  await fetch('/api/buffer/append', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content: chunk,
      source_type: 'voice',
      is_final: isFinal
    })
  });
}

// Automatically flushes when:
// 1. is_final = true
// 2. 5 seconds elapsed since first chunk
// 3. 50 chunks accumulated
```

### Quick Text Notes

```typescript
// User types quick notes in succession
await fetch('/api/buffer/append', {
  method: 'POST',
  body: JSON.stringify({
    content: "Buy milk",
    source_type: "text"
  })
});

// If another note within 2 seconds, they merge
await fetch('/api/buffer/append', {
  method: 'POST',
  body: JSON.stringify({
    content: "and eggs",
    source_type: "text"
  })
});

// Result: "Buy milk and eggs" sent as one item to InboxManager
```

### Explicit Send Button

```typescript
// User clicks "Send" button
await fetch('/api/buffer/flush', {
  method: 'POST'
});

// Immediately flushes all buffered captures
```

## State Management

- **Persistent Storage**: Buffer state persists across Worker restarts
- **Alarms**: Scheduled alarms trigger automatic flush based on maxAgeMs
- **Concurrency**: Uses Durable Object guarantees for safe concurrent access

## Error Handling

- Failed flushes keep items in buffer and retry on next flush
- Network errors during append return immediately but don't lose data
- Alarm reschedules automatically if buffer has remaining items

## Performance Considerations

1. **One Buffer Per User**: Uses `${tenantId}:${userId}` as DO name for isolation
2. **Batching**: Reduces InboxManager calls by 10-50x for rapid captures
3. **Memory**: Each buffer holds max ~50 chunks × ~500 chars = ~25KB typical
4. **Latency**: Adds 0-5s latency but dramatically reduces backend load

## Monitoring

Check buffer health:
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-worker.workers.dev/api/buffer/status
```

View buffered items:
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-worker.workers.dev/api/buffer
```

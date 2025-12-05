#!/bin/bash

# CaptureBuffer Integration Test Script
# This script tests the CaptureBuffer API endpoints against a running Worker

set -e

# Configuration
BASE_URL="${BASE_URL:-http://localhost:8787}"
TENANT_ID="${TENANT_ID:-}"
USER_ID="${USER_ID:-}"
TOKEN="${TOKEN:-}"

echo "🧪 CaptureBuffer Integration Tests"
echo "=================================="
echo ""

# Check if we have a token
if [ -z "$TOKEN" ]; then
  echo "⚠️  No TOKEN set. Running /setup first..."
  SETUP_RESPONSE=$(curl -s -X POST "$BASE_URL/setup")
  echo "Setup response: $SETUP_RESPONSE"

  TOKEN=$(echo $SETUP_RESPONSE | jq -r '.data.token')
  TENANT_ID=$(echo $SETUP_RESPONSE | jq -r '.data.tenant_id')
  USER_ID=$(echo $SETUP_RESPONSE | jq -r '.data.user_id')

  echo "✅ Got token: ${TOKEN:0:20}..."
  echo "   Tenant: $TENANT_ID"
  echo "   User: $USER_ID"
  echo ""
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"

echo "Test 1: Get initial buffer status"
echo "-----------------------------------"
STATUS_RESPONSE=$(curl -s -H "$AUTH_HEADER" "$BASE_URL/api/buffer/status")
echo "Response: $STATUS_RESPONSE" | jq .
echo ""

echo "Test 2: Append first chunk"
echo "-----------------------------------"
APPEND_RESPONSE=$(curl -s -X POST \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Buy milk",
    "source_type": "text"
  }' \
  "$BASE_URL/api/buffer/append")
echo "Response: $APPEND_RESPONSE" | jq .
echo ""

echo "Test 3: Append second chunk (should merge)"
echo "-----------------------------------"
sleep 0.5  # Within merge window
APPEND_RESPONSE=$(curl -s -X POST \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "and eggs",
    "source_type": "text"
  }' \
  "$BASE_URL/api/buffer/append")
echo "Response: $APPEND_RESPONSE" | jq .
echo ""

echo "Test 4: Get buffer contents"
echo "-----------------------------------"
BUFFER_RESPONSE=$(curl -s -H "$AUTH_HEADER" "$BASE_URL/api/buffer")
echo "Response: $BUFFER_RESPONSE" | jq .
CHUNK_COUNT=$(echo $BUFFER_RESPONSE | jq -r '.data.buffer[0].chunk_count // 0')
echo "Chunk count in first capture: $CHUNK_COUNT"
if [ "$CHUNK_COUNT" -eq 2 ]; then
  echo "✅ Chunks merged successfully!"
else
  echo "⚠️  Expected 2 chunks, got $CHUNK_COUNT"
fi
echo ""

echo "Test 5: Configure buffer"
echo "-----------------------------------"
CONFIG_RESPONSE=$(curl -s -X POST \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{
    "maxChunks": 100,
    "maxAgeMs": 10000
  }' \
  "$BASE_URL/api/buffer/configure")
echo "Response: $CONFIG_RESPONSE" | jq .
echo ""

echo "Test 6: Verify config updated"
echo "-----------------------------------"
STATUS_RESPONSE=$(curl -s -H "$AUTH_HEADER" "$BASE_URL/api/buffer/status")
MAX_CHUNKS=$(echo $STATUS_RESPONSE | jq -r '.data.config.maxChunks')
if [ "$MAX_CHUNKS" -eq 100 ]; then
  echo "✅ Config updated successfully!"
else
  echo "⚠️  Expected maxChunks=100, got $MAX_CHUNKS"
fi
echo ""

echo "Test 7: Append voice chunk with is_final=false"
echo "-----------------------------------"
VOICE_RESPONSE=$(curl -s -X POST \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "This is a voice transcription",
    "source_type": "voice",
    "is_final": false
  }' \
  "$BASE_URL/api/buffer/append")
echo "Response: $VOICE_RESPONSE" | jq .
echo ""

echo "Test 8: Append final voice chunk (should trigger flush)"
echo "-----------------------------------"
VOICE_FINAL_RESPONSE=$(curl -s -X POST \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "final part",
    "source_type": "voice",
    "is_final": true
  }' \
  "$BASE_URL/api/buffer/append")
echo "Response: $VOICE_FINAL_RESPONSE" | jq .
echo ""

echo "Test 9: Force flush remaining buffer"
echo "-----------------------------------"
FLUSH_RESPONSE=$(curl -s -X POST \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  "$BASE_URL/api/buffer/flush")
echo "Response: $FLUSH_RESPONSE" | jq .
echo ""

echo "Test 10: Verify buffer is empty after flush"
echo "-----------------------------------"
sleep 1  # Give flush time to complete
BUFFER_RESPONSE=$(curl -s -H "$AUTH_HEADER" "$BASE_URL/api/buffer")
echo "Response: $BUFFER_RESPONSE" | jq .
BUFFER_LENGTH=$(echo $BUFFER_RESPONSE | jq -r '.data.buffer | length')
echo "Buffer length: $BUFFER_LENGTH"
if [ "$BUFFER_LENGTH" -eq 0 ]; then
  echo "✅ Buffer flushed successfully!"
else
  echo "⚠️  Buffer not empty, length: $BUFFER_LENGTH"
fi
echo ""

echo "=================================="
echo "✅ All tests completed!"
echo ""
echo "To run manually:"
echo "  export TOKEN='$TOKEN'"
echo "  curl -H \"Authorization: Bearer \$TOKEN\" $BASE_URL/api/buffer/status"

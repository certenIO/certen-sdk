# Authentication

All API requests (except `/health`) require authentication via an API key.

## API Key Format

API keys use the prefix `ck_live_` followed by a random string:

```
ck_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

Keys are issued through the admin API and can only be viewed at creation time. They are stored as SHA-256 hashes in the database.

## Passing the API Key

Include the key in the `X-API-Key` header on every request:

```bash
curl https://gateway.kompendium.co/v1/portfolio \
  -H "X-API-Key: ck_live_a1b2c3d4e5f6..."
```

## Error Responses

### 401 Unauthorized

Returned when the API key is missing, malformed, or invalid.

```json
{ "error": "Missing X-API-Key header" }
```

```json
{ "error": "Invalid API key format" }
```

```json
{ "error": "Invalid API key" }
```

### 403 Forbidden

Returned when the API key exists but is deactivated or expired.

```json
{ "error": "API key is deactivated" }
```

```json
{ "error": "API key has expired" }
```

## Rate Limiting

Each API key is subject to rate limiting (default: 60 requests per minute). When the limit is exceeded, the API responds with:

**HTTP 429 Too Many Requests**

```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

Rate limits are applied per API key. If no API key is present, rate limiting falls back to the client IP address.

The following response headers are included on every request:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed per window |
| `X-RateLimit-Remaining` | Remaining requests in current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |

## Key Management

### Create a Key

```bash
curl -X POST https://gateway.kompendium.co/v1/admin/api-keys \
  -H "X-API-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production-backend",
    "org_id": "org-uuid",
    "permissions": ["read", "write"],
    "rate_limit_rpm": 120,
    "expires_at": "2026-12-31T23:59:59Z"
  }'
```

### List Keys

```bash
curl https://gateway.kompendium.co/v1/admin/api-keys \
  -H "X-API-Key: $ADMIN_KEY"
```

Only key prefixes are returned; raw keys are never stored or retrievable.

### Revoke a Key

```bash
curl -X DELETE https://gateway.kompendium.co/v1/admin/api-keys/{key_id} \
  -H "X-API-Key: $ADMIN_KEY"
```

Revoked keys are immediately deactivated and cannot be restored.

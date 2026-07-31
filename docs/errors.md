# Error Handling

All error responses from the CERTEN Gateway API follow a consistent format and use standard HTTP status codes.

## Error Response Format

```json
{
  "error": "Human-readable error message",
  "code": "MACHINE_READABLE_CODE"
}
```

Validation errors include additional detail:

```json
{
  "error": "Validation error",
  "code": "VALIDATION_ERROR",
  "details": [
    {
      "keyword": "required",
      "params": { "missingProperty": "name" },
      "message": "must have required property 'name'"
    }
  ]
}
```

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `BAD_REQUEST` | 400 | The request body or parameters are invalid |
| `UNAUTHORIZED` | 401 | Authentication is missing or invalid |
| `FORBIDDEN` | 403 | The API key is deactivated, expired, or lacks permission |
| `NOT_FOUND` | 404 | The requested resource does not exist or is not accessible |
| `CONFLICT` | 409 | The resource already exists (e.g., duplicate identity name) |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests; slow down and retry |
| `VALIDATION_ERROR` | 400 | Request body failed schema validation |
| `BAD_GATEWAY` | 502 | A downstream service (api-bridge, proofs service) returned an error |
| `INTERNAL_ERROR` | 500 | An unexpected server error occurred |

## HTTP Status Code Summary

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 201 | Resource created |
| 400 | Bad request / validation error |
| 401 | Authentication required |
| 403 | Access denied |
| 404 | Not found |
| 409 | Conflict |
| 429 | Rate limited |
| 500 | Internal server error |
| 502 | Bad gateway (downstream failure) |

## Common Scenarios

### Missing API Key

```
HTTP 401
{ "error": "Missing X-API-Key header" }
```

### Invalid Request Body

```
HTTP 400
{ "error": "identity_id is required", "code": "BAD_REQUEST" }
```

### Resource Not Found

```
HTTP 404
{ "error": "Identity not found", "code": "NOT_FOUND" }
```

### Downstream Service Failure

```
HTTP 502
{ "error": "Failed to prepare transaction intent", "code": "BAD_GATEWAY" }
```

### Rate Limited

```
HTTP 429
{ "error": "Rate limit exceeded", "code": "RATE_LIMIT_EXCEEDED" }
```

## Retry Guidance

- **4xx errors**: Do not retry automatically. Fix the request and try again.
- **429 errors**: Wait until the `X-RateLimit-Reset` timestamp, then retry.
- **502 errors**: Retry with exponential backoff. The downstream service may be temporarily unavailable.
- **500 errors**: Retry with exponential backoff. If persistent, contact support.

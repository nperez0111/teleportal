# Rate Limiting

This guide demonstrates how to configure rate limiting in Teleportal to protect your server from abuse and excessive message traffic.

## What it demonstrates

- Configuring multiple rate limit rules with different tracking strategies
- Using per-user, per-document, and user-document pair rate limits
- Implementing shared rate limit storage for multi-node deployments with `UnstorageRateLimitStorage`
- Setting up callbacks for rate limit violations and message size violations
- Configuring maximum message sizes to prevent abuse
- Client behavior that triggers rate limiting by rapidly sending messages

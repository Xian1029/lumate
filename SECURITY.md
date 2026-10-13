# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Lumate, please report it responsibly:

1. **Do NOT** open a public GitHub issue for security vulnerabilities.
2. Email your report to the maintainer (see `package.json` or the repository owner's profile).
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We aim to acknowledge reports within 48 hours and provide a fix within 7 days for critical issues.

## Security Best Practices for Deployment

- **Protect single-user deployments at the network boundary.** The default
  `AUTH_ENABLED=false` mode gives every visitor access to the same owner data.
  Limit access with a private network or an authenticated reverse proxy.
  To use JWT login, set `AUTH_ENABLED=true` and a strong `JWT_SECRET_KEY`.
- **Keep CSRF protection enabled.** Set a stable `CSRF_SECRET_KEY` (>= 32 characters)
  for production, including deployments without JWT login.
- **Rotate API keys regularly.** Never commit `.env` files to version control.
- **Use HTTPS in production.** The CSRF middleware automatically sets `Secure` cookies in production mode.
- **Keep dependencies updated.** Run `pip-audit` and `npm audit` regularly.
- **Use container isolation for code sandbox.** Set `CODE_SANDBOX_BACKEND=container` in production.

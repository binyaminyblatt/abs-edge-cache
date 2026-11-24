# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.
Use GitHub's private reporting instead: go to the Security tab
and choose "Report a vulnerability".

Include a description, steps to reproduce, the affected
version or commit, and the impact you see.

## What to expect

We will acknowledge reports as soon as possible and keep you
updated on progress toward a fix. We follow coordinated
disclosure and are happy to credit you unless you prefer to
stay anonymous.

## Supported versions

Only the latest release and the main branch receive fixes.

## Scope

In scope: this project's Worker code, such as cache leaks
between users, authentication or cache-validation bypasses,
cache poisoning, request-forwarding abuse, and credentials
appearing in logs.

Out of scope: Audiobookshelf itself (please report those
upstream), and issues in Cloudflare's platform.

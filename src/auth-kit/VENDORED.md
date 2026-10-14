# Vendored: @velotech/auth-kit

Source of truth: github.com/velotechsystems/lib-auth-kit
Pinned version: v0.3.0 (lib-auth-kit AUTHKIT-03, 2026-10-14; copied verbatim,
no local edits). Previously e1db5c11d9a3c8c9915abd3c27b1ae5ffbd22f02 (v0.2.0).

v0.3 changed the app contract: resolveSsoUser(orgSlug, identity) returns a user
or { denied }, onSsoDenied(event) gets an address only when the provider
verified it, and Microsoft stays off unless auth.ts declares
microsoftDirectoryBinding (it does not; see auth.ts).

Per the kit's consumption model, this `src/` is COPIED here (not an npm dep) and
imported via `@/src/auth-kit`. To update: re-copy from the lib repo and bump the
pinned commit above in the PR description. Only `create-auth-config.ts` changes
when central VeloTech ID (Phase 2) lands.

# Contributing to ShadowCrypt

Thank you for your interest in contributing to ShadowCrypt! This document outlines the process for reporting bugs, proposing features, and submitting code changes.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Features](#suggesting-features)
  - [Submitting Code](#submitting-code)
- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Security Issues](#security-issues)

---

## Code of Conduct

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before contributing.

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/ShadowCrypt.git
   cd ShadowCrypt
   ```
3. **Install** dependencies:
   ```bash
   pnpm install
   ```
4. **Set up** environment variables (see [README.md](README.md#quick-start)).
5. **Create a branch** for your work:
   ```bash
   git checkout -b feat/my-feature
   ```

---

## How to Contribute

### Reporting Bugs

Before filing a bug report:
- Search existing [issues](https://github.com/Forestritium/ShadowCrypt/issues) to avoid duplicates.
- Confirm you are running the latest version.

When filing, include:
- A clear, descriptive title.
- Steps to reproduce the issue.
- Expected vs. actual behaviour.
- Browser, OS, and version details.
- Any relevant console errors or screenshots.

> **Security vulnerabilities** must NOT be filed as public issues. See [SECURITY.md](SECURITY.md).

### Suggesting Features

Open a [GitHub Discussion](https://github.com/Forestritium/ShadowCrypt/discussions) or issue with:
- The problem your feature solves.
- Your proposed solution.
- Any alternative approaches you considered.
- Whether you are willing to implement it yourself.

### Submitting Code

- One feature or fix per pull request — keep PRs focused.
- Write clear commit messages following the [Commit Conventions](#commit-conventions) below.
- Add or update tests where applicable.
- Ensure `pnpm run lint` passes with zero errors before opening the PR.
- Reference any related issues in the PR description (`Closes #123`).

---

## Development Setup

```bash
pnpm install       # Install dependencies
pnpm dev           # Start local dev server (http://localhost:5173)
pnpm run lint      # Run type-check + biome lint + build check
```

The lint script runs:
1. `tsgo` — TypeScript type checking
2. `biome lint` — code style and correctness
3. Tailwind CSS syntax validation
4. A full production build via Vite

All four must pass before a PR will be reviewed.

---

## Code Style

ShadowCrypt uses [Biome](https://biomejs.dev) for linting and formatting.

Key conventions:
- **2-space indentation** throughout.
- **No default exports** for utility functions — use named exports.
- **TypeScript strict mode** — no `any`, no unchecked casts without justification.
- **No direct Tailwind colour values** (e.g. `bg-blue-500`) — use semantic tokens (`bg-primary`, `text-muted-foreground`).
- **Cryptography** — all crypto operations must go through `src/lib/crypto.ts`. Never use third-party crypto libraries for core encryption without a security review.
- **No plaintext storage** — never write user message content, keys, or passwords to `localStorage` or unencrypted DB columns.
- Comments should explain *why*, not *what*. Remove dead code instead of commenting it out.

---

## Commit Conventions

Follow the [Conventional Commits](https://www.conventionalcommits.org) specification:

```
<type>(<scope>): <short summary>
```

| Type | When to use |
|---|---|
| `feat` | New user-visible feature |
| `fix` | Bug fix |
| `chore` | Maintenance, dependency updates, tooling |
| `docs` | Documentation changes only |
| `refactor` | Code restructuring without behaviour change |
| `perf` | Performance improvements |
| `style` | Formatting, whitespace (no logic changes) |
| `test` | Adding or updating tests |
| `build` | Build system or config changes |
| `ci` | CI/CD pipeline changes |

Examples:
```
feat(auth): add BIP-39 recovery phrase on registration
fix(relay): prevent duplicate message delivery on reconnect
chore: remove unused embla-carousel dependency
docs: add SECURITY.md and threat model
```

---

## Pull Request Process

1. Ensure your branch is up-to-date with `main`:
   ```bash
   git fetch origin
   git rebase origin/main
   ```
2. Open a PR against `main` on the **public** fork (`Forestritium/ShadowCrypt`).
3. Fill in the PR template completely.
4. A maintainer will review within 7 days. Address any requested changes promptly.
5. Once approved and CI passes, a maintainer will merge the PR.

---

## Security Issues

Do **not** open public issues for security vulnerabilities. Please follow the responsible disclosure process described in [SECURITY.md](SECURITY.md).

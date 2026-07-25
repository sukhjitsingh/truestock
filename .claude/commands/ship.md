---
description: Pre-deploy gate — review, security audit, typecheck, build
---

Run the pre-deploy sequence and stop at the first failure:

1. `code-reviewer` on the diff since the last tag
2. `security-reviewer` full audit
3. Typecheck and lint
4. Production build, and report the output size
5. Confirm `output: 'standalone'` and `images: { unoptimized: true }` are still set

Summarise as a go / no-go with the reasons.

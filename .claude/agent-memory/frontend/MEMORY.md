# Frontend agent memory — Truestock

- [locations-row-click-a11y-fix](project_locations_row_click_a11y_fix.md) — the Edit-button fix applied to both locations (957bfeb) and vendors (5fd5eeb); the template if the row-click pattern turns up again
- [verify-browser-check-count-is-data-dependent](feedback_verify_browser_check_count_is_data_dependent.md) — verify:browser's check count/FAILs depend on dev-DB fixtures (par level, closed count, ANY recorded count line); diff FAIL lines across two runs before calling one a regression
- [playwright-e2e-traps](feedback_playwright_e2e_traps.md) — e2e/ suite traps: favicon.ico unobservable (use onLine=false), fake BarcodeDetector must return an array, TanStack sort order, cost-cell remount known defect
- [parallel-dev-stale-contract-and-shared-docker-stack](feedback_parallel_dev_stale_contract_and_shared_docker_stack.md) — verify a provisional contract against landed files not the brief; a shared docker stack can vanish OR silently serve the wrong branch (test -f before trusting it); retention_until on hand-seeded invoices; sandbox refuses complex heredocs, use Write instead; test:docker isn't worktree-project-scoped, pass -p/-f by hand

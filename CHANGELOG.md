# Changelog

All notable changes to **Argus** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repository baseline scaffolding (SECURITY.md, ISSUE_TEMPLATE forms, dependabot config, pre-commit hooks).

### Changed
- **BREAKING**: Renamed `/instructor` route to `/overview`, the standalone multi-device monitoring page.
  - Renamed `argus/web/templates/instructor.html` → `overview.html`.
  - Renamed `argus/web/static/js/instructor.js` → `overview.js`.
  - Renamed CSS class `instructor-card` → `overview-card`.
  - Renamed localStorage key `argus-instructor-devices` → `argus-overview-devices` (existing browser state will not migrate; users must re-add their device list).
- Decoupled training/curriculum framing from the public repo. Documentation now describes generic operator/field-user roles instead of student/instructor terminology.
- Updated README, CLAUDE.md, configuration reference, and getting-started guide accordingly.

### Removed
- `courseware/` directory (29 reference slide JPGs) — internal training material, no longer shipped publicly.
- `Course Materials` section from README.
- Persona-specific recursive dev session prompts from CLAUDE.md (the neutral version stays in `docs/guides/PROMPTS.md`).

### Fixed
-

### Security
- Enabled GitHub Dependabot vulnerability alerts and automated security update PRs.
- Enabled GitHub secret scanning + push protection.

[Unreleased]: https://github.com/rmeadomavic/Argus/commits/main

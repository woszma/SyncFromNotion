# Changelog

## [1.2.1] - 2026-02-16

### Fixed
- **Image Sync Logic**: Fixed an issue where images were not updating when "Sync Selected Instance" was used, due to URL comparison logic. Now forces update for selected instances.
- **Sync Selected Button**: Fixed the "Sync Selected Instance" button being disabled after confirming mappings.
- **Mapping Storage**: Fixed inconsistent storage format for mappings (JSON string vs Object), ensuring reliable loading.
- **Duplicate Event Handlers**: Removed duplicate `sync-selected-done` handlers that were causing incorrect behavior.
- **Quick Load UI**: Fixed an issue where "Load from Selection" would redirect the UI to the mapping step instead of staying in the Tools view.
- **Null Checks**: Added null checks in mapping confirmation to prevent "Cannot read properties of null" errors.

## [1.2.0] - 2026-02-13
- Initial release details...

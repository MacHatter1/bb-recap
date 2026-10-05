# Changelog

All notable changes to Recap are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Add an Expanded banner display mode: the compact banner opens expanded and can still be collapsed.

### Fixed

- Move Refresh and Expand/Collapse into the compact banner's header line, so the recap text spans the full banner width below it. On phones Refresh is a ↻ icon that spins while busy, and Expand/Collapse shows only its arrow.
- Keep the Refresh button at a fixed width, so the recap text beside it no longer reflows while it briefly reads "Loading…" or "Generating…".

## 0.2.3 - 2026-10-01

### Fixed

- Keep incremental recaps correct when older timeline pages fall outside the bounded history window, and retain context from existing recaps after upgrading.
- Prevent queued automatic recaps from starting after automatic generation is disabled.
- Keep generation errors visible after refreshing the Recap panel.
- Preserve the last usable recap when cleanup removes a suppressed refresh attempt.

### Changed

- Share model-option normalization and typed generation reasons across their consumers.

## 0.2.2 - 2026-09-25

### Changed

- Prevent recap generation for hidden threads, including hidden workers.
- Abort generation when a thread becomes hidden and recheck visibility before
  submitting its transcript.

## 0.2.1 - 2026-09-14

### Changed

- Refresh recaps with the previous summary and only the new turns, reducing repeated transcript input.

## 0.2.0 - 2026-08-31

### Added

- Limit concurrent recap workers and retry transient automatic failures.
- Capture fictional-data screenshots of recap displays and settings.

### Changed

- Schedule automatic recaps from thread activity instead of scanning idle threads at startup.
- Hide the composer recap banner while editing an inline message.

## 0.1.0 - 2026-08-30

### Added

- Release Recap as a BB plugin for generating and displaying thread summaries.

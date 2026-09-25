# Changelog

All notable changes to Recap are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

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
